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
import { ClaimGrants, TokenVerifier } from "livekit-server-sdk";
import { PhotonImage } from "@cf-wasm/photon";
import { getIndicesAbove, sortByIndex, UnknownRecord } from "tldraw";

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
    .get("/connect/:roomId", async (request) => {
      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handleConnect(request);
    })
    .get("/rooms/:roomId/pages", async (request) => {
      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handleGetPages(request);
    })
    .put("/rooms/:roomId/pages", async (request) => {
      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handlePutPages(request);
    })
    .delete("/rooms/:roomId/pages", async (request) => {
      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handleDeletePages(request);
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
    })
    .post("/save/study/:userId/:hash", async (request) => {
      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          const roomId = `${request.params.userId}/${request.params.hash}`;
          await this.ctx.storage.put("roomId", roomId);
          this.roomId = roomId;
        });
      }
      return this.handleStudySave(request);
    })
    .post("/disconnect/study/:userId/:hash", async (request) => {
      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          const roomId = `${request.params.userId}/${request.params.hash}`;
          await this.ctx.storage.put("roomId", roomId);
          this.roomId = roomId;
        });
      }
      return this.handleStudyDisconnect(request);
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

  async handleGetPages(request: IRequest): Promise<Response> {
    const roomId = this.roomId;
    if (!roomId) {
      console.error("Missing roomId");
      return error(400, "Missing roomId");
    }

    const token = request.headers.get("Authorization")?.split(" ")[1];
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

    const room = await this.getRoom();
    const snapshot = room.getCurrentSnapshot();
    const pages = snapshot.documents
      .filter((document) => document.state.typeName === "page")
      .map((document) => ({
        ...document,
        id: document.state.id.split(":")[1],
      }));
    const sortedPages = pages.sort((a: any, b: any) =>
      sortByIndex(a.state, b.state)
    );
    return new Response(JSON.stringify({ data: { pages: sortedPages } }), {
      status: 200,
    });
  }

  async handleCreatePages(request: IRequest): Promise<Response> {
    const roomId = this.roomId;
    if (!roomId) {
      console.error("Missing roomId");
      return error(400, "Missing roomId");
    }

    const token = request.headers.get("Authorization")?.split(" ")[1];
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

    const room = await this.getRoom();
    const snapshot = room.getCurrentSnapshot();
    const pages = snapshot.documents
      .filter((document) => document.state.typeName === "page")
      .map((document) => ({
        ...document,
        id: document.state.id.split(":")[1],
      }));
    return new Response(JSON.stringify({ pages: pages }), { status: 200 });
  }

  async handlePutPages(request: IRequest): Promise<Response> {
    const roomId = this.roomId;
    if (!roomId) {
      console.error("Missing roomId");
      return error(400, "Missing roomId");
    }

    const body = await request.json<any>();
    if (
      !body ||
      !body.input ||
      !body.input.pages ||
      !Array.isArray(body.input.pages)
    ) {
      console.error("Missing pages");
      return error(400, "Missing pages");
    }

    const token = request.headers.get("Authorization")?.split(" ")[1];
    if (!token) {
      console.error("Missing token");
      return error(400, "Missing token");
    }

    let payload: ClaimGrants;
    try {
      payload = await new TokenVerifier(
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

    const nodeId = payload.attributes?.nodeId;
    if (!nodeId) {
      console.error("Missing nodeId");
      return error(400, "Missing nodeId");
    }

    const room = await this.getRoom();
    const snapshot = room.getCurrentSnapshot();
    const pageDocuments = snapshot.documents.filter((document) => {
      const state = document.state as any;
      return state.typeName === "page";
    });
    const sortedPageDocuments = pageDocuments.sort((a: any, b: any) =>
      sortByIndex(a.state, b.state)
    );
    const lastPageDocument =
      sortedPageDocuments.length > 0
        ? sortedPageDocuments[sortedPageDocuments.length - 1]
        : { state: { index: "a1" } };
    const lastPageState = lastPageDocument.state as any;
    const aboveIndices = getIndicesAbove(
      lastPageState.index,
      body.input.pages.length
    );

    const pages: RoomSnapshot["documents"] = [];
    const pageFromDocuments: {
      lastChangedClock: number;
      state: any;
    }[] = [];
    const errors: {
      message: string;
      extensions: { id: string; image: string; thumbnail?: string };
    }[] = [];
    const pagePromises = body.input.pages.map(async (page: { id: string; image?: string; thumbnail?: string }, pageIndex: number) => {
      const index = aboveIndices[pageIndex];
      if (!index) return;

      // const pageDocument = pageDocuments.find(
      //   (document) => document.state.id === `page:${page.id}`
      // );
      // if (pageDocument) {
      //   const state = pageDocument.state as any;
      //   state.index = index;
      //   return;
      // }

      const pageFromBucket = await this.r2.get(
        `study/${nodeId}/${page.id}.json`
      );
      if (pageFromBucket) {
        const documents = await pageFromBucket.json<
          RoomSnapshot["documents"]
        >();
        return documents.map((document) => {
          const state = document.state as any;
          if (state.typeName === "page") state.index = index;
          return document;
        });
      } else if (page.image) {
        // const pageDocument = pageDocuments.find(
        //   (document) => document.state.id === `page:${page.id}`
        // );
        // if (pageDocument) {
        //   const state = pageDocument.state as any;
        //   state.index = index;
        //   return [pageDocument];
        // }

        try {
          const inputBytes = await fetch(page.image)
            .then((res) => res.arrayBuffer())
            .then((buffer) => new Uint8Array(buffer));

          // create a PhotonImage instance
          const inputImage = PhotonImage.new_from_byteslice(inputBytes);
          const w = inputImage.get_width() * 2;
          const h = inputImage.get_height() * 2;
          const base64 = inputImage.get_base64();
          inputImage.free();
          const match = base64.match(/^data:([^;]+)/);
          if (!match) return;
          const mimeType = match[1];
          return [
            {
              state: {
                meta: {
                  thumbnail: page.thumbnail ?? page.image,
                },
                id: `page:${page.id}`,
                name: `${page.id}`,
                index: index,
                typeName: "page",
              },
              lastChangedClock: 0,
            },
            {
              state: {
                id: `asset:${page.id}`,
                type: "image",
                typeName: "asset",
                props: {
                  name: `${page.id}`,
                  src: `${page.image}`,
                  w: w,
                  h: h,
                  mimeType: mimeType,
                  isAnimated: false,
                },
                meta: {},
              },
              lastChangedClock: 0,
            },
            {
              state: {
                x: 0,
                y: 0,
                rotation: 0,
                isLocked: true,
                opacity: 1,
                meta: {},
                id: `shape:${page.id}`,
                type: "image",
                typeName: "shape",
                index: "a1",
                parentId: `page:${page.id}`,
                props: {
                  w: w,
                  h: h,
                  assetId: `asset:${page.id}`,
                  playing: true,
                  url: "",
                  crop: null,
                  flipX: false,
                  flipY: false,
                  altText: "",
                },
              },
              lastChangedClock: 0,
            }
          ];
        } catch (err) {
          throw {
            message: `${err}`,
            extensions: {
              id: page.id,
              image: page.image,
              thumbnail: page.thumbnail,
            },
          };
        }
      }
    });

    const results = await Promise.allSettled(pagePromises);
    
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        pageFromDocuments.push(...result.value);
      } else if (result.status === 'rejected') {
        errors.push(result.reason);
      }
    });

    await room.updateStore((store) => {
      for (const document of pageFromDocuments) {
        store.put(document.state as TLRecord);
        if (document.state.typeName === "page") pages.push(document);
      }
    });

    const sortedPages = pages.map((document) => ({
      ...document,
      id: document.state.id.split(":")[1],
    }));
    return new Response(
      JSON.stringify({
        data: { pages: sortedPages },
        errors: errors.length ? errors : undefined,
      }),
      {
        status: 200,
      }
    );
  }

  async handleDeletePages(request: IRequest): Promise<Response> {
    const roomId = this.roomId;
    if (!roomId) {
      console.error("Missing roomId");
      return error(400, "Missing roomId");
    }

    const body = await request.json<any>();
    if (
      !body ||
      !body.input ||
      !body.input.pages ||
      !Array.isArray(body.input.pages)
    ) {
      console.error("Missing body");
      return error(400, "Missing body");
    }

    const token = request.headers.get("Authorization")?.split(" ")[1];
    if (!token) {
      console.error("Missing token");
      return error(400, "Missing token");
    }

    let payload: ClaimGrants;
    try {
      payload = await new TokenVerifier(
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

    const pageIds = body.input.pages.map((page: any) => page.id);
    let pageRecords: {
      lastChangedClock: number;
      state: UnknownRecord;
    }[] = [];
    const room = await this.getRoom();
    const snapshot = room.getCurrentSnapshot();
    await room.updateStore((store) => {
      for (const document of snapshot.documents) {
        if (
          document.state.typeName === "page" &&
          pageIds.includes(document.state.id.split(":")[1])
        ) {
          pageRecords.push(document);
          store.delete(document.state.id);
        }
      }
    });

    const pages = pageRecords.map((document) => ({
      ...document,
      id: document.state.id.split(":")[1],
    }));

    return new Response(JSON.stringify({ data: { pages: pages } }), {
      status: 200,
    });
  }

  getRoom() {
    const roomId = this.roomId;
    if (!roomId) throw new Error("Missing roomId");

    if (!this.roomPromise) {
      this.roomPromise = (async () => {
        // fetch the room from R2
        const roomFromBucket = await this.r2.get(`room/${roomId}.json`);

        // if it doesn't exist, we'll just create a new empty room
        const initialSnapshot = roomFromBucket
          ? await roomFromBucket.json<RoomSnapshot>()
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
    await this.r2.put(`room/${this.roomId}.json`, snapshot);
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

      if (
        payload.attributes?.nodeId?.split("/").shift() !==
        roomId.split("/").shift()
      ) {
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
    room.updateStore((store) => {
      store.delete("page:page");
    });

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
        `study/${roomId.split("/").shift()}/${id}.json`
      );
      const pageDocuments = pageFromBucket
        ? await pageFromBucket.json<RoomSnapshot["documents"]>()
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

  async handleStudySave(request: IRequest): Promise<Response> {
    if (!this.roomId) throw new Error("Missing room");
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
    for await (const [id, documents] of Object.entries(pageDocuments)) {
      const snapshot = JSON.stringify(documents);
      await this.r2.put(
        `study/${this.roomId.split("/").shift()}/${id}.json`,
        snapshot
      );
    }

    return new Response(null, { status: 200 });
  }

  async handleStudyDisconnect(request: IRequest): Promise<Response> {
    const sessionId = request.query.sessionId as string;
    if (!sessionId) {
      console.error("Missing sessionId");
      return error(400, "Missing sessionId");
    }

    const roomId = this.roomId;
    if (!roomId) throw new Error("Missing roomId");

    const room = await this.getStudyRoom();
    room.handleSocketClose(sessionId);
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
            `study/${roomId.split("/").shift()}/${id}.json`
          );
          const documents = pageFromBucket
            ? await pageFromBucket.json<RoomSnapshot["documents"]>()
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
        `study/${this.roomId.split("/").shift()}/${id}.json`,
        snapshot
      );
    }
  }, 10_000);
}
