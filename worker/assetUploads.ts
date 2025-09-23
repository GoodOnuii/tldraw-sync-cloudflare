import { IRequest, error } from 'itty-router'
import { Environment } from './types'
import { UUID } from 'bson'

// R2Object 타입 정의 (Cloudflare Workers에서 제공하지 않는 경우)
interface R2Object {
	body: ReadableStream | null
	httpMetadata: Record<string, string>
}

// assets are stored in the bucket under the /uploads path
function getAssetObjectName(uploadId: string) {
	return `upload/${uploadId.replace(/[^a-zA-Z0-9\_\-]+/g, '_')}`
}

// when a user uploads an asset, we store it in the bucket. we only allow image and video assets.
export async function handleAssetUpload(request: IRequest, env: Environment) {
	const uploadId = new UUID().toString()
	const objectName = getAssetObjectName(uploadId)

	const contentType = request.headers.get('content-type') ?? ''
	if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
		return error(400, 'Invalid content type')
	}

	// chunk 업로드인지 확인
	const chunkIndex = request.headers.get('X-Chunk-Index')
	const totalChunks = request.headers.get('X-Total-Chunks')
	
	if (chunkIndex && totalChunks) {
		// chunk 업로드 처리
		return await handleChunkUpload(request, env, objectName, chunkIndex, totalChunks)
	}

	if (await env.TLDRAW_BUCKET.head(objectName)) {
		return error(409, 'Upload already exists')
	}

	await env.TLDRAW_BUCKET.put(objectName, request.body, {
		httpMetadata: request.headers,
	})

	return { ok: true, data: { id: uploadId } }
}

// chunk 업로드 처리 함수
async function handleChunkUpload(
	request: IRequest, 
	env: Environment, 
	baseObjectName: string, 
	chunkIndex: string, 
	totalChunks: string
) {
	const chunkObjectName = `${baseObjectName}.chunk${chunkIndex}`
	
	// chunk가 이미 존재하는지 확인
	if (await env.TLDRAW_BUCKET.head(chunkObjectName)) {
		return error(409, 'Chunk already exists')
	}

	// chunk를 R2에 저장
	await env.TLDRAW_BUCKET.put(chunkObjectName, request.body, {
		httpMetadata: {
			...request.headers,
			'X-Chunk-Index': chunkIndex,
			'X-Total-Chunks': totalChunks,
		},
	})

	// 모든 chunk가 업로드되었는지 확인
	const uploadedChunks = await checkAllChunksUploaded(env, baseObjectName, parseInt(totalChunks))
	
	if (uploadedChunks) {
		// 모든 chunk를 합쳐서 원본 파일 생성
		await combineChunks(env, baseObjectName, parseInt(totalChunks))
	}

	return { ok: true, chunkIndex: parseInt(chunkIndex), totalChunks: parseInt(totalChunks) }
}

// 모든 chunk가 업로드되었는지 확인
async function checkAllChunksUploaded(env: Environment, baseObjectName: string, totalChunks: number): Promise<boolean> {
	for (let i = 0; i < totalChunks; i++) {
		const chunkObjectName = `${baseObjectName}.chunk${i}`
		const chunk = await env.TLDRAW_BUCKET.head(chunkObjectName)
		if (!chunk) {
			return false
		}
	}
	return true
}

// 모든 chunk를 합쳐서 원본 파일 생성
async function combineChunks(env: Environment, baseObjectName: string, totalChunks: number) {
	const chunks: R2Object[] = []
	
	// 모든 chunk를 순서대로 가져오기
	for (let i = 0; i < totalChunks; i++) {
		const chunkObjectName = `${baseObjectName}.chunk${i}`
		const chunk = await env.TLDRAW_BUCKET.get(chunkObjectName)
		if (chunk) {
			chunks.push(chunk)
		}
	}

	if (chunks.length !== totalChunks) {
		throw new Error('Not all chunks are available')
	}

	// chunk들을 하나의 스트림으로 합치기
	const combinedStream = new ReadableStream({
		start(controller) {
			let chunkIndex = 0
			
			function pump() {
				if (chunkIndex >= chunks.length) {
					controller.close()
					return
				}
				
				const reader = chunks[chunkIndex].body?.getReader()
				if (!reader) {
					controller.close()
					return
				}
				
				reader.read().then(({ done, value }) => {
					if (done) {
						chunkIndex++
						pump()
					} else {
						controller.enqueue(value)
						pump()
					}
				})
			}
			
			pump()
		}
	})

	// 합쳐진 파일을 R2에 저장
	await env.TLDRAW_BUCKET.put(baseObjectName, combinedStream, {
		httpMetadata: chunks[0].httpMetadata,
	})

	// chunk 파일들 삭제 (선택사항)
	for (let i = 0; i < totalChunks; i++) {
		const chunkObjectName = `${baseObjectName}.chunk${i}`
		await env.TLDRAW_BUCKET.delete(chunkObjectName)
	}
}

// when a user downloads an asset, we retrieve it from the bucket. we also cache the response for performance.
export async function handleAssetDownload(
	request: IRequest,
	env: Environment,
	ctx: ExecutionContext
) {
	// chunk 다운로드인지 확인
	const chunkIndex = request.params.chunkIndex
	if (chunkIndex !== undefined) {
		return await handleChunkDownload(request, env, ctx)
	}

	const objectName = getAssetObjectName(request.params.uploadId)

	// if we have a cached response for this request (automatically handling ranges etc.), return it
	const cacheKey = new Request(request.url, { headers: request.headers })
	const cachedResponse = await caches.default.match(cacheKey)
	if (cachedResponse) {
		return cachedResponse
	}

	// if not, we try to fetch the asset from the bucket
	const object = await env.TLDRAW_BUCKET.get(objectName, {
		range: request.headers,
		onlyIf: request.headers,
	})

	if (!object) {
		return error(404)
	}

	// write the relevant metadata to the response headers
	const headers = new Headers()
	object.writeHttpMetadata(headers)

	// assets are immutable, so we can cache them basically forever:
	headers.set('cache-control', 'public, max-age=31536000, immutable')
	headers.set('etag', object.httpEtag)

	// we set CORS headers so all clients can access assets. we do this here so our `cors` helper in
	// worker.ts doesn't try to set extra cors headers on responses that have been read from the
	// cache, which isn't allowed by cloudflare.
	headers.set('access-control-allow-origin', '*')

	// cloudflare doesn't set the content-range header automatically in writeHttpMetadata, so we
	// need to do it ourselves.
	let contentRange
	if (object.range) {
		if ('suffix' in object.range) {
			const start = object.size - object.range.suffix
			const end = object.size - 1
			contentRange = `bytes ${start}-${end}/${object.size}`
		} else {
			const start = object.range.offset ?? 0
			const end = object.range.length ? start + object.range.length - 1 : object.size - 1
			if (start !== 0 || end !== object.size - 1) {
				contentRange = `bytes ${start}-${end}/${object.size}`
			}
		}
	}

	if (contentRange) {
		headers.set('content-range', contentRange)
	}

	// make sure we get the correct body/status for the response
	const body = 'body' in object && object.body ? object.body : null
	const status = body ? (contentRange ? 206 : 200) : 304

	// we only cache complete (200) responses
	if (status === 200) {
		const [cacheBody, responseBody] = body!.tee()
		ctx.waitUntil(caches.default.put(cacheKey, new Response(cacheBody, { headers, status })))
		return new Response(responseBody, { headers, status })
	}

	return new Response(body, { headers, status })
}
