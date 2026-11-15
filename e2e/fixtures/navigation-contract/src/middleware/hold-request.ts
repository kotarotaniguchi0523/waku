import { waitForGate } from '../lib/gate.js';

type Context = { req: { raw: Request } };

// Holds any request that names a gate with `hold=<id>` until a spec opens it,
// so the response does not even start. The name can sit anywhere in the URL,
// however the router encodes the page's query in its own requests.
const holdRequest = () => async (c: Context, next: () => Promise<void>) => {
  let url = c.req.raw.url;
  for (let i = 0; i < 2; i++) {
    try {
      url = decodeURIComponent(url);
    } catch {
      break;
    }
  }
  const gateId = /[?&=]hold=([\w-]+)/.exec(url)?.[1];
  if (gateId) {
    await waitForGate(gateId);
  }
  return next();
};

export default holdRequest;
