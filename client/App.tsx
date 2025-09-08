import { useSync } from "@tldraw/sync";
import { Tldraw } from "tldraw";
import { getBookmarkPreview } from "./getBookmarkPreview";
import { multiplayerAssetStore } from "./multiplayerAssetStore";

// Where is our worker located? Configure this in `vite.config.ts`
const WORKER_URL = process.env.TLDRAW_WORKER_URL;

// In this example, the room ID is hard-coded. You can set this however you like though.
const roomId = "5b92dd06-bfa6-4f2b-8550-f1b86fe956c7";
const userId = "c7491759-be90-4b54-bb42-519a6dc9e346";

// Persistently allowed temporary key for development
// const token =
//   "eyJhbGciOiJIUzI1NiJ9.eyJhdHRyaWJ1dGVzIjp7Im5vZGVJZCI6ImM3NDkxNzU5LWJlOTAtNGI1NC1iYjQyLTUxOWE2ZGM5ZTM0NiJ9LCJuYW1lIjoi66as7ZSEKDU2MTk3MykiLCJpc3MiOiJjZjZlNjNlMi0xMDY3LTQ3MDgtOTIyNS1iYTcwNWIyMzVmMjUiLCJleHAiOjE3NTk2NDIwNTksIm5iZiI6MCwic3ViIjoiYzc0OTE3NTktYmU5MC00YjU0LWJiNDItNTE5YTZkYzllMzQ2LzIwMjUtMDktMDVUMDUyNzM5In0.seFkJxOjBO-2pDpS6rj5hmBaRfepVsfPk90ENfcRkCQ";
const token = "eyJhbGciOiJIUzI1NiJ9.eyJhdHRyaWJ1dGVzIjp7Im5vZGVJZCI6ImM3NDkxNzU5LWJlOTAtNGI1NC1iYjQyLTUxOWE2ZGM5ZTM0NiJ9LCJuYW1lIjoi7KCc7J2065OgMTAoNTYyOTk5KSIsInZpZGVvIjp7InJvb20iOiI1YjkyZGQwNi1iZmE2LTRmMmItODU1MC1mMWI4NmZlOTU2YzciLCJyb29tSm9pbiI6dHJ1ZSwiY2FuUHVibGlzaCI6dHJ1ZSwiY2FuU3Vic2NyaWJlIjp0cnVlfSwiaXNzIjoiY2Y2ZTYzZTItMTA2Ny00NzA4LTkyMjUtYmE3MDViMjM1ZjI1IiwiZXhwIjoxNzU3MzEyMjkzLCJuYmYiOjAsInN1YiI6IjdiZjYzYTRlLTRjMmQtNDg5OS05NjRkLWJkMzgxODcyYzQ5ZC8yMDI1LTA5LTA1VDA2MTgxMyJ9.ClduoO_l6yae_gXVyKQ1N2XriCEUEiSoP524iBcKplo"

// // Token generation logic that should be embedded mobile app
// async function createToken(roomId: string) {
// 	const res = await fetch("https://canvas.dev.seoltab.com/graphql", {
// 		method: "POST",
// 		headers: {
// 			"Content-Type": "application/json",
// 			// "Authorization": `Bearer ${token}`
// 		},
// 		body: JSON.stringify({
// 			query: `
// 			mutation {
// 				createToken(input: {
// 					roomId: "${roomId}"
// 				}) {
// 					token
// 					wsUrl
// 				}
// 			}
// 			`
// 		})
// 	})
// 	return res.json()
// }

function App() {
  // const { data } = await createToken(roomId)
  const pages = ["id1,id2,id3"];

  // Create a store connected to multiplayer.
  const store = useSync({
    // We need to know the websockets URI...
    // uri: `${WORKER_URL}/connect/study/${userId}/${roomId}?token=${token}&pages=${pages.join(",")}`,
    uri: `${WORKER_URL}/connect/${roomId}?token=${token}`,
    // ...and how to handle static assets like images & videos
    assets: multiplayerAssetStore,
  });

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Tldraw
        // we can pass the connected store into the Tldraw component which will handle
        // loading states & enable multiplayer UX like cursors & a presence menu
        store={store}
        onMount={(editor) => {
          // when the editor is ready, we need to register our bookmark unfurling service
          editor.registerExternalAssetHandler("url", getBookmarkPreview);
        }}
      />
    </div>
  );
}

export default App;
