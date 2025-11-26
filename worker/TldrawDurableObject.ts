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
  private sessions: {
    [id: string]: {
      username: string;
      connectedAt: string;
      disconnectedAt: string;
    };
  } = {};
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
      if (request.query.hash) {
        if (!this.roomId || !this.pages) {
          await this.ctx.blockConcurrencyWhile(async () => {
            const roomId = `${request.params.roomId}/${request.query.hash}`;
            const pages = request.query.pages;
            await this.ctx.storage.put("roomId", roomId);
            this.roomId = roomId;
            this.pages = `${pages}`;
          });
        }
        return this.handleStudyConnect(request);
      }

      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handleConnect(request);
    })
    .post("/disconnect/:userId", async (request) => {
      if (request.query.hash) {
        if (!this.roomId) {
          await this.ctx.blockConcurrencyWhile(async () => {
            const roomId = `${request.params.roomId}/${request.query.hash}`;
            await this.ctx.storage.put("roomId", roomId);
            this.roomId = roomId;
          });
        }
        return this.handleStudyDisconnect(request);
      }
    })
    .post("/rooms/:roomId", async (request) => {
      if (request.query.hash) {
        if (!this.roomId) {
          await this.ctx.blockConcurrencyWhile(async () => {
            const roomId = `${request.params.roomId}/${request.query.hash}`;
            await this.ctx.storage.put("roomId", roomId);
            this.roomId = roomId;
          });
        }
        return this.handleStudySave(request);
      }
    })
    .delete("/rooms/:roomId", async (request) => {
      if (request.query.hash) {
        if (!this.roomId) {
          await this.ctx.blockConcurrencyWhile(async () => {
            await this.ctx.storage.put("roomId", request.params.roomId);
            this.roomId = request.params.roomId;
          });
        }
        return this.handleStudyDelete(request);
      }
    })
    .get("/rooms/:roomId/pages", async (request) => {
      if (request.query.hash) {
        if (!this.roomId || !this.pages) {
          await this.ctx.blockConcurrencyWhile(async () => {
            const roomId = `${request.params.roomId}/${request.query.hash}`;
            const pages = request.query.pages;
            await this.ctx.storage.put("roomId", roomId);
            this.roomId = roomId;
            this.pages = `${pages}`;
          });
        }
        return this.handleStudyGetPages(request);
      }

      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handleGetPages(request);
    })
    .put("/rooms/:roomId/pages", async (request) => {
      if (request.query.hash) {
        if (!this.roomId) {
          await this.ctx.blockConcurrencyWhile(async () => {
            const roomId = `${request.params.roomId}/${request.query.hash}`;
            await this.ctx.storage.put("roomId", roomId);
            this.roomId = roomId;
          });
        }
        return this.handleStudyUpdate(request);
      }

      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handlePutPages(request);
    })
    .delete("/rooms/:roomId/pages", async (request) => {
      if (request.query.hash) {
        if (!this.roomId) {
          await this.ctx.blockConcurrencyWhile(async () => {
            const roomId = `${request.params.roomId}/${request.query.hash}`;
            await this.ctx.storage.put("roomId", roomId);
            this.roomId = roomId;
          });
        }
        return this.handleStudyDeletePages(request);
      }

      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handleDeletePages(request);
    })
    .get("/rooms/:roomId/sessions", async (request) => {
      if (!this.roomId) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.put("roomId", request.params.roomId);
          this.roomId = request.params.roomId;
        });
      }
      return this.handleGetSessions(request);
    });

  // `fetch` is the entry point for all requests to the Durable Object
  fetch(request: Request): Response | Promise<Response> {
    return this.router.fetch(request);
  }

  // what happens when someone tries to connect to this room?
  async handleConnect(request: IRequest): Promise<Response> {
    // extract query params from request
    // const sessionId = request.query.sessionId as string;
    // if (!sessionId) {
    //   console.error("Missing sessionId");
    //   return error(400, "Missing sessionId");
    // }

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

    const payload = await new TokenVerifier(
      this.LIVEKIT_API_KEY,
      this.LIVEKIT_API_SECRET
    )
      .verify(token)
      .catch((err) => {
        console.error("Invalid token", err);
        throw error(401, "Invalid token");
      });

    if (payload.video?.room !== roomId) {
      console.error("Invalid roomId");
      return error(401, "Invalid roomId");
    }

    const sub = payload.sub;
    if (!sub) {
      console.error("Missing payload.sub");
      return error(400, "Missing payload.sub");
    }

    const name = payload.name;
    if (!name) {
      console.error("Missing payload.name");
      return error(400, "Missing payload.name");
    }

    // Create the websocket pair for the client
    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    serverWebSocket.accept();

    // load the room, or retrieve it if it's already loaded
    const room = await this.getRoom();
    const sessionId = sub.split("/").shift() + "/" + new Date().toISOString();
    this.sessions[sessionId] = {
      username: name.match(/\d+/g)?.join("") ?? "",
      connectedAt: new Date().toISOString(),
      disconnectedAt: "",
    };

    // connect the client to the room
    room.handleSocketConnect({
      sessionId: sessionId,
      socket: serverWebSocket,
      isReadonly: (request.query.readonly as string) === "1",
    });

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
    const pagePromises = body.input.pages.map(
      async (
        page: {
          id: string;
          image?: string;
          thumbnail?: string;
          width?: number;
          height?: number;
          mimeType?: string;
        },
        pageIndex: number
      ) => {
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
            let w = 0;
            let h = 0;
            let mimeType = "";
            if (page.width && page.height && page.mimeType) {
              w = page.width;
              h = page.height;
              mimeType = page.mimeType;
            } else {
              const inputBytes = await fetch(page.image)
                .then((res) => res.arrayBuffer())
                .then((buffer) => new Uint8Array(buffer));
              const inputImage = PhotonImage.new_from_byteslice(inputBytes);
              w = inputImage.get_width();
              h = inputImage.get_height();
              const base64 = inputImage.get_base64();
              inputImage.free();
              const match = base64.match(/^data:([^;]+)/);
              if (!match) return;
              mimeType = match[1];
            }

            return [
              {
                state: {
                  meta: {
                    thumbnail: page.thumbnail ? page.thumbnail : page.image,
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
              },
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
      }
    );

    const results = await Promise.allSettled(pagePromises);

    results.forEach((result) => {
      if (result.status === "fulfilled" && result.value) {
        pageFromDocuments.push(...result.value);
      } else if (result.status === "rejected") {
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

  async handleGetSessions(request: IRequest): Promise<Response> {
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

    const room = await this.getRoom();

    const sessionsFromBucket = await this.r2.get(
      `room/${this.roomId}/sessions.json`
    );
    const sessions = sessionsFromBucket
      ? await sessionsFromBucket.json<{
          [id: string]: {
            username: string;
            connectedAt: string;
            disconnectedAt: string;
          };
        }>()
      : {};

    for (const [id, session] of Object.entries(this.sessions)) {
      if (!sessions[id]) sessions[id] = session;
    }

    const activeSessionIds = new Set(
      room
        .getSessions()
        .map((session) => (session.isConnected ? session.sessionId : null))
        .filter((id) => id !== null)
    );

    for (const [id, session] of Object.entries(sessions)) {
      if (session.disconnectedAt || activeSessionIds.has(id)) continue;

      session.disconnectedAt = new Date().toISOString();
      if (this.sessions[id] && !this.sessions[id].disconnectedAt) {
        this.sessions[id].disconnectedAt = session.disconnectedAt;
      }
    }
    const sessionsToBucket = JSON.stringify(sessions);
    await this.r2.put(`room/${this.roomId}/sessions.json`, sessionsToBucket);

    const sessionsToReturn = Object.entries(sessions).map(([id, session]) => ({
      id: id,
      username: session.username,
      connectedAt: session.connectedAt,
      disconnectedAt: session.disconnectedAt,
    }));

    return new Response(
      JSON.stringify({
        data: { sessions: sessionsToReturn },
      }),
      {
        status: 200,
      }
    );

    // const sessionsFromBucket = await this.r2.get(
    //   `room/${this.roomId}/sessions.json`
    // );
    // const sessions = sessionsFromBucket
    //   ? await sessionsFromBucket.json<{
    //       [id: string]: {
    //         username: string;
    //         connectedAt: string;
    //         disconnectedAt: string;
    //       };
    //     }>()
    //   : this.sessions;

    // const sessionsMap: {
    //   [id: string]: {
    //     username: string;
    //     connectedAt: string;
    //     disconnectedAt: string;
    //   };
    // } = {};
    // for (const [id, session] of Object.entries(sessions)) {
    //   if (!sessionsMap[id]) {
    //     sessionsMap[id] = {
    //       username: session.username,
    //       connectedAt: session.connectedAt,
    //       disconnectedAt: session.disconnectedAt,
    //     };
    //   }

    //   if (sessionsMap[id].disconnectedAt) continue;
    //   if (this.sessions[id]) continue;

    //   sessionsMap[id].disconnectedAt = new Date().toISOString();
    // }

    // const sessionsToReturn = Object.entries(sessionsMap).map(
    //   ([id, session]) => ({
    //     id: id,
    //     username: session.username,
    //     connectedAt: session.connectedAt,
    //     disconnectedAt: session.disconnectedAt,
    //   })
    // );

    // return new Response(
    //   JSON.stringify({
    //     data: { sessions: sessionsToReturn },
    //   }),
    //   {
    //     status: 200,
    //   }
    // );
  }

  getRoom() {
    const roomId = this.roomId;
    if (!roomId) throw new Error("Missing roomId");

    if (!this.roomPromise) {
      this.roomPromise = (async () => {
        // fetch the room from R2
        const roomFromBucket = await this.r2.get(
          `room/${roomId}/snapshot.json`
        );

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
    await this.r2.put(`room/${this.roomId}/snapshot.json`, snapshot);

    const sessionsFromBucket = await this.r2.get(
      `room/${this.roomId}/sessions.json`
    );
    const sessions = sessionsFromBucket
      ? await sessionsFromBucket.json<{
          [id: string]: {
            username: string;
            connectedAt: string;
            disconnectedAt: string;
          };
        }>()
      : {};

    for (const [id, session] of Object.entries(this.sessions)) {
      if (!sessions[id]) sessions[id] = session;
    }

    const activeSessionIds = new Set(
      room
        .getSessions()
        .map((session) => (session.isConnected ? session.sessionId : null))
        .filter((id) => id !== null)
    );

    for (const [id, session] of Object.entries(sessions)) {
      if (session.disconnectedAt || activeSessionIds.has(id)) continue;

      session.disconnectedAt = new Date().toISOString();
      if (this.sessions[id] && !this.sessions[id].disconnectedAt) {
        this.sessions[id].disconnectedAt = session.disconnectedAt;
      }
    }
    const sessionsToBucket = JSON.stringify(sessions);
    await this.r2.put(`room/${this.roomId}/sessions.json`, sessionsToBucket);
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

    const payload = await new TokenVerifier(
      this.LIVEKIT_API_KEY,
      this.LIVEKIT_API_SECRET
    )
      .verify(token)
      .catch((err) => {
        console.error("Invalid token", err);
        throw error(401, "Invalid token");
      });

    if (
      payload.attributes?.nodeId?.split("/").shift() !==
      roomId.split("/").shift()
    ) {
      console.error("Invalid roomId");
      return error(401, "Invalid roomId");
    }

    // Create the websocket pair for the client
    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    serverWebSocket.accept();

    // load the room, or retrieve it if it's already loaded
    const room = await this.getStudyRoom();

    // connect the client to the room
    room.handleSocketConnect({
      sessionId: sessionId,
      socket: serverWebSocket,
      isReadonly: (request.query.readonly as string) === "1",
    });

    // return the websocket connection to the client
    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }

  async handleStudyGetPages(request: IRequest): Promise<Response> {
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

    const room = await this.getStudyRoom();
    const snapshot = room.getCurrentSnapshot();

    const drawShapesByPageId = new Map<string, boolean>();
    snapshot.documents.forEach((doc) => {
      const state = doc.state as any;
      if (
        state.typeName === "shape" &&
        state.type === "draw" &&
        state.parentId
      ) {
        const pageId = state.parentId.split(":")[1];
        drawShapesByPageId.set(pageId, true);
      }
    });

    const pageDocuments = snapshot.documents
      .filter((document) => document.state.typeName === "page")
      .map((document) => {
        const pageId = document.state.id.split(":")[1];

        // Use the pre-built lookup map for O(1) draw shape check
        const hasDrawShape = drawShapesByPageId.has(pageId);

        return {
          ...document,
          id: pageId,
          hasDrawShape,
        };
      });

    const sortedPages = pageDocuments.sort((a: any, b: any) =>
      sortByIndex(a.state, b.state)
    );
    return new Response(JSON.stringify({ data: { pages: sortedPages } }), {
      status: 200,
    });
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

  async handleStudyDeletePages(request: IRequest): Promise<Response> {
    if (!this.roomId) throw new Error("Missing room");

    const pages = this.pages;
    if (!pages) return error(400, "Missing pages");

    const room = await this.getStudyRoom();
    room.loadSnapshot({ clock: 0, documents: [] });

    return new Response(null, { status: 200 });
  }

  async handleStudyDelete(request: IRequest): Promise<Response> {
    if (!this.roomId) throw new Error("Missing room");

    const studyFiles = await this.r2.list({
      prefix: `study/${this.roomId}/`,
    });
    await this.r2.delete(studyFiles.objects.flatMap((file) => file.key));

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
        const [userId, hash] = roomId.split("/");
        const pageDocuments: RoomSnapshot["documents"] = [];
        for (const id of pageIds) {
          const document = await this.r2.get(`study/${userId}/${id}.json`);
          const documents = document
            ? await document.json<RoomSnapshot["documents"]>()
            : [];
          pageDocuments.push(...documents);
        }

        const snapshotFromBucket = await this.r2.get(
          `study/${userId}/${hash}.json`
        );
        const initialSnapshot: RoomSnapshot = snapshotFromBucket
          ? await snapshotFromBucket.json<RoomSnapshot>()
          : { clock: 0, documents: [] };
        initialSnapshot.clock = 0;
        initialSnapshot.documents =
          pageDocuments.length > 0 ? pageDocuments : [];
        if (pageDocuments.length > 0)
          initialSnapshot.schema = {
            schemaVersion: 2,
            sequences: {
              "com.tldraw.store": 4,
              "com.tldraw.asset": 1,
              "com.tldraw.camera": 1,
              "com.tldraw.document": 2,
              "com.tldraw.instance": 25,
              "com.tldraw.instance_page_state": 5,
              "com.tldraw.page": 1,
              "com.tldraw.instance_presence": 6,
              "com.tldraw.pointer": 1,
              "com.tldraw.shape": 4,
              "com.tldraw.asset.bookmark": 2,
              "com.tldraw.asset.image": 5,
              "com.tldraw.asset.video": 5,
              "com.tldraw.shape.arrow": 6,
              "com.tldraw.shape.bookmark": 2,
              "com.tldraw.shape.draw": 2,
              "com.tldraw.shape.embed": 4,
              "com.tldraw.shape.frame": 1,
              "com.tldraw.shape.geo": 10,
              "com.tldraw.shape.group": 0,
              "com.tldraw.shape.highlight": 1,
              "com.tldraw.shape.image": 5,
              "com.tldraw.shape.line": 5,
              "com.tldraw.shape.note": 9,
              "com.tldraw.shape.text": 3,
              "com.tldraw.shape.video": 4,
              "com.tldraw.binding.arrow": 1,
            },
          };

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
      if (id === null || id === "page") continue;
      if (pageDocuments[id]) pageDocuments[id].push(document);
      else pageDocuments[id] = [document];
    }
    if (Object.keys(pageDocuments).length === 0) return;

    // convert the room to JSON and upload it to R2
    const [userId, hash] = this.roomId.split("/");
    const schema = JSON.stringify({ schema: currentSnapshot.schema });
    await this.r2.put(`study/${userId}/${hash}.json`, schema);
    for await (const [id, documents] of Object.entries(pageDocuments)) {
      const document = JSON.stringify(documents);
      await this.r2.put(`study/${userId}/${id}.json`, document);
    }
  }, 10_000);
}
