import { GoogleCustomSearch } from '@langchain/community/tools/google_custom_search';

export const tools = [new GoogleCustomSearch({ apiKey: process.env.KEY, googleCSEId: process.env.CX })];
