import { RoomSnapshot, TLSocketRoom } from "@tldraw/sync-core";
import {
  TLRecord,
  createTLSchema,
  // defaultBindingSchemas,
  defaultShapeSchemas,
} from "@tldraw/tlschema";
import { AutoRouter, IRequest, cors, error } from "itty-router";
import throttle from "lodash.throttle";
import { Environment } from "./types";
import { TokenVerifier } from "livekit-server-sdk";
import { UnknownRecord } from "tldraw";

// add custom shapes and bindings here if needed:
const schema = createTLSchema({
  shapes: { ...defaultShapeSchemas },
  // bindings: { ...defaultBindingSchemas },
});

// each whiteboard room is hosted in a DurableObject:
// https://developers.cloudflare.com/durable-objects/

// there's only ever one durable object instance per room. it keeps all the room state in memory and
// handles websocket connections. periodically, it persists the room state to the R2 bucket.
export class TldrawDurableObject {
  private r2: R2Bucket;
  // the room ID will be missing while the room is being initialized
  private roomId: string | null = null;
  private pages: string | null = null;
  // when we load the room from the R2 bucket, we keep it here. it's a promise so we only ever
  // load it once.
  private roomPromise: Promise<TLSocketRoom<TLRecord, void>> | null = null;

  private LIVEKIT_API_KEY: string;
  private LIVEKIT_API_SECRET: string;

  constructor(private readonly ctx: DurableObjectState, env: Environment) {
    this.r2 = env.TLDRAW_BUCKET;
    this.LIVEKIT_API_KEY = env.LIVEKIT_API_KEY;
    this.LIVEKIT_API_SECRET = env.LIVEKIT_API_SECRET;

    ctx.blockConcurrencyWhile(async () => {
      this.roomId = ((await this.ctx.storage.get("roomId")) ?? null) as
        | string
        | null;
    });
  }

  private readonly router = AutoRouter({
    before: [cors({ origin: "*" }).preflight],
    finally: [cors({ origin: "*" }).corsify],
    catch: (e) => {
      console.log(e);
      return error(e);
    },
  })
    // when we get a connection request, we stash the room id if needed and handle the connection
    .get("/connect/:roomId", async (request) => {
      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handleConnect(request);
    })
    .get("/connect/study/:userId/:hash", async (request) => {
      if (!this.roomId || !this.pages) {
        await this.ctx.blockConcurrencyWhile(async () => {
          const roomId = `${request.params.userId}/${request.params.hash}`;
          const pages = request.query.pages;
          await this.ctx.storage.put("roomId", roomId);
          this.roomId = roomId;
          this.pages = `${pages}`;
        });
      }
      return this.handleStudyConnect(request);
    })
    .post("/update/study/:userId/:hash", async (request) => {
      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          const roomId = `${request.params.userId}/${request.params.hash}`;
          await this.ctx.storage.put("roomId", roomId);
          this.roomId = roomId;
        });
      }
      return this.handleStudyUpdate(request);
    });

  // `fetch` is the entry point for all requests to the Durable Object
  fetch(request: Request): Response | Promise<Response> {
    return this.router.fetch(request);
  }

  // what happens when someone tries to connect to this room?
  async handleConnect(request: IRequest): Promise<Response> {
    // extract query params from request
    const sessionId = request.query.sessionId as string;
    if (!sessionId) {
      console.error("Missing sessionId");
      return error(400, "Missing sessionId");
    }

    const roomId = this.roomId;
    if (!roomId) {
      console.error("Missing roomId");
      return error(400, "Missing roomId");
    }

    const token = request.query.token as string;
    if (!token) {
      console.error("Missing token");
      return error(400, "Missing token");
    }

    try {
      const payload = await new TokenVerifier(
        this.LIVEKIT_API_KEY,
        this.LIVEKIT_API_SECRET
      ).verify(token);

      if (payload.video?.room !== roomId) {
        console.error("Invalid roomId");
        return error(401, "Invalid roomId");
      }
    } catch (err) {
      console.error("Invalid token", err);
      return error(401, "Invalid token");
    }

    // Create the websocket pair for the client
    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    serverWebSocket.accept();

    // load the room, or retrieve it if it's already loaded
    const room = await this.getRoom();

    // connect the client to the room
    room.handleSocketConnect({ sessionId, socket: serverWebSocket });

    // return the websocket connection to the client
    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }

  getRoom() {
    const roomId = this.roomId;
    if (!roomId) throw new Error("Missing roomId");

    if (!this.roomPromise) {
      this.roomPromise = (async () => {
        // fetch the room from R2
        const roomFromBucket = await this.r2.get(`room/${roomId}`);

        // if it doesn't exist, we'll just create a new empty room
        const initialSnapshot = roomFromBucket
          ? ((await roomFromBucket.json()) as RoomSnapshot)
          : { clock: 0, documents: [] };

        // create a new TLSocketRoom. This handles all the sync protocol & websocket connections.
        // it's up to us to persist the room state to R2 when needed though.
        return new TLSocketRoom<TLRecord, void>({
          schema,
          initialSnapshot: initialSnapshot,
          onDataChange: () => {
            // and persist whenever the data in the room changes
            this.schedulePersistToR2();
          },
        });
      })();
    }

    return this.roomPromise;
  }

  // we throttle persistance so it only happens every 10 seconds
  schedulePersistToR2: ReturnType<typeof throttle> = throttle(async () => {
    if (!this.roomPromise || !this.roomId) return;
    const room = await this.getRoom();

    // convert the room to JSON and upload it to R2
    const snapshot = JSON.stringify(room.getCurrentSnapshot());
    await this.r2.put(`room/${this.roomId}`, snapshot);
  }, 10_000);

  // what happens when someone tries to connect to this room?
  async handleStudyConnect(request: IRequest): Promise<Response> {
    // extract query params from request
    const sessionId = request.query.sessionId as string;
    if (!sessionId) {
      console.error("Missing sessionId");
      return error(400, "Missing sessionId");
    }

    const roomId = this.roomId;
    if (!roomId) {
      console.error("Missing roomId");
      return error(400, "Missing roomId");
    }

    const token = request.query.token as string;
    if (!token) {
      console.error("Missing token");
      return error(400, "Missing token");
    }

    const pages = this.pages as string;
    if (!pages) {
      console.error("Missing pages");
      return error(400, "Missing pages");
    }

    try {
      const payload = await new TokenVerifier(
        this.LIVEKIT_API_KEY,
        this.LIVEKIT_API_SECRET
      ).verify(token);

      if (payload.attributes?.nodeId?.split("/").shift() !== roomId.split("/").shift()) {
        console.error("Invalid roomId");
        return error(401, "Invalid roomId");
      }
    } catch (err) {
      console.error("Invalid token", err);
      return error(401, "Invalid token");
    }

    // Create the websocket pair for the client
    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    serverWebSocket.accept();

    // load the room, or retrieve it if it's already loaded
    const room = await this.getStudyRoom();

    // connect the client to the room
    room.handleSocketConnect({ sessionId, socket: serverWebSocket });

    // return the websocket connection to the client
    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }

  async handleStudyUpdate(request: IRequest): Promise<Response> {
    const roomId = this.roomId;
    if (!roomId) throw new Error("Missing roomId");

    const pages = this.pages;
    if (!pages) return error(400, "Missing pages");
    const pageIds = pages.split(",");

    const room = await this.getStudyRoom();
    for await (const id of pageIds) {
      const pageFromBucket = await this.r2.get(
        `study/${roomId.split("/").shift()}/${id}`
      );
      const pageDocuments = pageFromBucket
        ? ((await pageFromBucket.json()) as RoomSnapshot["documents"])
        : [];
      room.updateStore((store) => {
        for (const document of pageDocuments) {
          store.put(document.state as TLRecord);
        }
      });
    }
    room.updateStore((store) => {
      store.delete("page:page");
    });
    return new Response(null, { status: 200 });
  }

  getStudyRoom() {
    const roomId = this.roomId;
    if (!roomId) throw new Error("Missing roomId");

    const pages = this.pages;
    if (!pages) throw new Error("Missing pages");
    const pageIds = pages.split(",");

    if (!this.roomPromise) {
      this.roomPromise = (async () => {
        // fetch the room from R2
        const pageDocuments: RoomSnapshot["documents"] = [];
        for (const id of pageIds) {
          const pageFromBucket = await this.r2.get(
            `study/${roomId.split("/").shift()}/${id}`
          );
          const documents = pageFromBucket
            ? ((await pageFromBucket.json()) as RoomSnapshot["documents"])
            : [];
          pageDocuments.push(...documents);
        }

        // if it doesn't exist, we'll just create a new empty room
        const initialSnapshot =
          pageDocuments.length > 0
            ? { clock: 0, documents: pageDocuments }
            : { clock: 0, documents: [] };

        // create a new TLSocketRoom. This handles all the sync protocol & websocket connections.
        // it's up to us to persist the room state to R2 when needed though.
        return new TLSocketRoom<TLRecord, void>({
          schema,
          initialSnapshot,
          onDataChange: async () => {
            // and persist whenever the data in the room changes
            this.studySchedulePersistToR2();
          },
        });
      })();
    }

    return this.roomPromise;
  }

  // we throttle persistance so it only happens every 10 seconds
  studySchedulePersistToR2: ReturnType<typeof throttle> = throttle(async () => {
    if (!this.roomPromise || !this.roomId) return;
    const room = await this.getStudyRoom();

    const currentSnapshot = room.getCurrentSnapshot();
    const pageDocuments: Record<
      string,
      { lastChangedClock: number; state: UnknownRecord }[]
    > = {};
    for (const document of currentSnapshot.documents) {
      const record = document.state as any;
      const id =
        record.typeName === "page"
          ? record.id.split(":")[1]
          : record.parentId
          ? record.parentId.split(":")[1]
          : record.typeName === "asset"
          ? record.id.split(":")[1]
          : null;
      if (id === null) continue;
      if (pageDocuments[id]) pageDocuments[id].push(document);
      else pageDocuments[id] = [document];
    }

    // convert the room to JSON and upload it to R2
    for (const [id, documents] of Object.entries(pageDocuments)) {
      const snapshot = JSON.stringify(documents);
      await this.r2.put(
        `study/${this.roomId.split("/").shift()}/${id}`,
        snapshot
      );
    }
  }, 10_000);
}
