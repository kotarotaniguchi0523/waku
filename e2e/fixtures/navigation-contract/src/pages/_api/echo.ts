export async function POST(req: Request) {
  const form = await req.formData();
  return new Response(`echo: ${String(form.get('message'))}`, {
    headers: { 'content-type': 'text/plain' },
  });
}
