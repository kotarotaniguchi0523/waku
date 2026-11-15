import { isGateWaiting, releaseGate } from '../../lib/gate.js';

const getId = (req: Request) => new URL(req.url).searchParams.get('id') ?? '';

// Reports whether a render is currently held at this gate.
export async function GET(req: Request) {
  return Response.json({ waiting: isGateWaiting(getId(req)) });
}

// Lets the held render continue.
export async function POST(req: Request) {
  releaseGate(getId(req));
  return new Response('released');
}
