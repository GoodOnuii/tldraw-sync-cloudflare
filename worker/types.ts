// the contents of the environment should mostly be determined by wrangler.toml. These entries match

import { JWK } from "jose"

// the bindings defined there.
export interface Environment {
	TLDRAW_BUCKET: R2Bucket
	TLDRAW_DURABLE_OBJECT: DurableObjectNamespace
	CANVAS_JWT_PUBLIC_KEY: JWK
}
