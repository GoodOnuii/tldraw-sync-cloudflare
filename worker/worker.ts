import { handleUnfurlRequest } from 'cloudflare-workers-unfurl'
import { AutoRouter, cors, error, IRequest } from 'itty-router'
import { handleAssetDownload, handleAssetUpload } from './assetUploads'
import { Environment } from './types'

// make sure our sync durable object is made available to cloudflare
export { TldrawDurableObject } from './TldrawDurableObject'

// we use itty-router (https://itty.dev/) to handle routing. in this example we turn on CORS because
// we're hosting the worker separately to the client. you should restrict this to your own domain.
const { preflight, corsify } = cors({ origin: '*' })
const router = AutoRouter<IRequest, [env: Environment, ctx: ExecutionContext]>({
	before: [preflight],
	finally: [corsify],
	catch: (e) => {
		console.error(e)
		return error(e)
	},
})
	// requests to /connect are routed to the Durable Object, and handle realtime websocket syncing
	.get('/connect/:roomId', (request, env) => {
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		    return room.fetch(request.url, { headers: request.headers, body: request.body })
		}
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { headers: request.headers, body: request.body })
	})
	.post('/disconnect/:roomId', (request, env) => {
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
			return room.fetch(request.url, { method: 'POST', headers: request.headers, body: request.body })
		}
	})
	.post('/rooms/:roomId', (request, env) => {
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { method: 'POST', headers: request.headers, body: request.body })
	})
	.delete('/rooms/:roomId', (request, env) => {
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { method: 'DELETE', headers: request.headers, body: request.body })
	})
	.get('/rooms/:roomId/pages', (request, env) => {
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
			return room.fetch(request.url, { headers: request.headers, body: request.body })
		}
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { headers: request.headers, body: request.body })
	})
	.put('/rooms/:roomId/pages', (request, env) => {
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
			return room.fetch(request.url, { method: 'PUT', headers: request.headers, body: request.body })
		}
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { method: 'PUT', headers: request.headers, body: request.body })
	})
	.delete('/rooms/:roomId/pages', (request, env) => {
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
			return room.fetch(request.url, { method: 'DELETE', headers: request.headers, body: request.body })
		}
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { method: 'DELETE', headers: request.headers, body: request.body })
	})
	.get('/rooms/:roomId/sessions', (request, env) => {
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { headers: request.headers, body: request.body })
	})

	// assets can be uploaded to the bucket under /uploads:
	.post('/uploads', handleAssetUpload)

	// they can be retrieved from the bucket too:
	.get('/uploads/:uploadId', handleAssetDownload)

	// bookmarks need to extract metadata from pasted URLs:
	.get('/unfurl', handleUnfurlRequest)

	.get('/v0/connect/:roomId', (request, env) => {
		const url = request.url.replace('/v0', '')
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		    return room.fetch(url, { headers: request.headers, body: request.body })
		}
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(url, { headers: request.headers, body: request.body })
	})
	.post('/v0/disconnect/:roomId', (request, env) => {
		const url = request.url.replace('/v0', '')
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
			return room.fetch(url, { method: 'POST', headers: request.headers, body: request.body })
		}
	})
	.post('/v0/rooms/:roomId', (request, env) => {
		const url = request.url.replace('/v0', '')
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(url, { method: 'POST', headers: request.headers, body: request.body })
	})
	.delete('/v0/rooms/:roomId', (request, env) => {
		const url = request.url.replace('/v0', '')
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(url, { method: 'DELETE', headers: request.headers, body: request.body })
	})
	.get('/v0/rooms/:roomId/pages', (request, env) => {
		const url = request.url.replace('/v0', '')
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
			return room.fetch(url, { headers: request.headers, body: request.body })
		}
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(url, { headers: request.headers, body: request.body })
	})
	.put('/v0/rooms/:roomId/pages', (request, env) => {
		const url = request.url.replace('/v0', '')
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
			return room.fetch(url, { method: 'PUT', headers: request.headers, body: request.body })
		}
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(url, { method: 'PUT', headers: request.headers, body: request.body })
	})
	.delete('/v0/rooms/:roomId/pages', (request, env) => {
		const url = request.url.replace('/v0', '')
		if (request.query.hash) {
			const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId + '/' + request.query.hash)
			const room = env.TLDRAW_DURABLE_OBJECT.get(id)
			return room.fetch(url, { method: 'DELETE', headers: request.headers, body: request.body })
		}
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(url, { method: 'DELETE', headers: request.headers, body: request.body })
	})
	.get('/v0/rooms/:roomId/sessions', (request, env) => {
		const url = request.url.replace('/v0', '')
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(url, { headers: request.headers, body: request.body })
	})

// export our router for cloudflare
export default router
