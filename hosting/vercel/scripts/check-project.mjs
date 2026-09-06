// Read-only guard against deploying this staged folder into a different project
// or interpreting a monorepo root directory a second time on the build server.
const token = process.env.VERCEL_TOKEN,
  id = process.env.VERCEL_PROJECT_ID,
  team = process.env.VERCEL_ORG_ID;
if (!token || !id || !team)
  throw Error("Set VERCEL_TOKEN, VERCEL_PROJECT_ID and VERCEL_ORG_ID");
const url = new URL(
  `https://api.vercel.com/v9/projects/${encodeURIComponent(id)}`,
);
url.searchParams.set("teamId", team);
const response = await fetch(url, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok)
  throw Error(`Cannot verify selected Vercel project: HTTP ${response.status}`);
const project = await response.json();
if (project.id !== id) throw Error("Vercel project identity differs");
if (project.rootDirectory)
  throw Error(
    "Clear the Vercel Root Directory override: CI uploads hosting/vercel itself as the project root",
  );
console.log("Verified Vercel project and upload root.");
