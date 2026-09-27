import { customsearch } from '@googleapis/customsearch';

export async function legacySearch(q) {
  const client = customsearch({ version: 'v1' });
  const res = await client.cse.list({ q, cx: process.env.CX, auth: process.env.KEY });
  return res.data.items ?? [];
}

// Everything below this line has moved to the bridge.

export async function search(q) {
  const client = customsearch({
    version: 'v1',
    rootUrl: 'http://localhost:8080/',
  });
  const res = await client.cse.list({ q, cx: process.env.CX, auth: process.env.KEY });
  return res.data.items ?? [];
}
