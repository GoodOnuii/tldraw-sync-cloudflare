import { useSync } from "@tldraw/sync";
import { Tldraw } from "tldraw";
import { getBookmarkPreview } from "./getBookmarkPreview";
import { multiplayerAssetStore } from "./multiplayerAssetStore";

// Where is our worker located? Configure this in `vite.config.ts`
const WORKER_URL = process.env.TLDRAW_WORKER_URL;

// In this example, the room ID is hard-coded. You can set this however you like though.
const roomId = "8cb97653-83e4-4086-8c7c-3cf9951d86ee";
const userId = "c7491759-be90-4b54-bb42-519a6dc9e346";

// Persistently allowed temporary key for development
const token =
  "eyJhbGciOiJIUzI1NiJ9.eyJuYW1lIjoi66as7ZSEKDU2MTk3MykiLCJ2aWRlbyI6eyJyb29tIjoiOGNiOTc2NTMtODNlNC00MDg2LThjN2MtM2NmOTk1MWQ4NmVlIiwicm9vbUpvaW4iOnRydWUsImNhblB1Ymxpc2giOnRydWUsImNhblN1YnNjcmliZSI6dHJ1ZX0sImlzcyI6ImNmNmU2M2UyLTEwNjctNDcwOC05MjI1LWJhNzA1YjIzNWYyNSIsImV4cCI6MTc1NzAzNjkyMSwibmJmIjowLCJzdWIiOiJjNzQ5MTc1OS1iZTkwLTRiNTQtYmI0Mi01MTlhNmRjOWUzNDYvMjAyNS0wOS0wMlQwMTQ4NDEifQ.JfCKcMBF-FdTl8D6-dQUoFH0RIcsjZijE6myuu9IKwc";

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
    uri: `${WORKER_URL}/connect/study/${userId}/${roomId}?token=${token}&pages=${pages.join(",")}`,
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
