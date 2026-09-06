export function GET() {
  return Response.json({
    ok: true,
    platform: "vercel",
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    webmcp: "browser-mediated",
  });
}
