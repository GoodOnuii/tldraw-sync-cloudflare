import { useSync } from '@tldraw/sync'
import { Tldraw } from 'tldraw'
import { getBookmarkPreview } from './getBookmarkPreview'
import { multiplayerAssetStore } from './multiplayerAssetStore'

// Where is our worker located? Configure this in `vite.config.ts`
const WORKER_URL = process.env.TLDRAW_WORKER_URL

// In this example, the room ID is hard-coded. You can set this however you like though.
const roomId = '95eaae6e-bdd8-4ba4-ae3b-6287f93cd5e5'

// Persistently allowed temporary key for development
const token = 'eyJhbGciOiJFUzI1NiJ9.eyJyb29tSWQiOiI5NWVhYWU2ZS1iZGQ4LTRiYTQtYWUzYi02Mjg3ZjkzY2Q1ZTUiLCJyb290Ijp0cnVlLCJpYXQiOjE3NDgzOTkzMzcsImlzcyI6ImNhbnZhcy5zZW9sdGFiLmNvbSIsImF1ZCI6ImNhbnZhcy5zZW9sdGFiLmNvbSIsImV4cCI6MjA2Mzk3NTMzN30.g3vxfdzJ_I6FkZlsU-0dVcs891U5rlp3FoBSFtLCnWD733_DuJj-42au72eCK6r81gLVWj03AOTsukwLx1tSJg'

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

async function App() {
	// const { data } = await createToken(roomId)

	// Create a store connected to multiplayer.
	const store = useSync({
		// We need to know the websockets URI...
		uri: `${WORKER_URL}/connect/${roomId}?token=${token}`,
		// ...and how to handle static assets like images & videos
		assets: multiplayerAssetStore,
	})

	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw
				// we can pass the connected store into the Tldraw component which will handle
				// loading states & enable multiplayer UX like cursors & a presence menu
				store={store}
				onMount={(editor) => {
					// when the editor is ready, we need to register our bookmark unfurling service
					editor.registerExternalAssetHandler('url', getBookmarkPreview)
				}}
			/>
		</div>
	)
}

export default App
