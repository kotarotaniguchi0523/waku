export async function GET() {
  return new Response('file contents', {
    headers: { 'content-type': 'text/plain' },
  });
}
