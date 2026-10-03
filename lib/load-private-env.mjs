import {fileURLToPath} from 'node:url';
import {loadPrivateAzureEnv} from './private-env.mjs';
// Only four Azure settings are loaded, after native dotenv parsing. Existing
// process environment wins, including an explicit XANDER_AZURE_ENABLED=0.
loadPrivateAzureEnv(fileURLToPath(new URL('../.env',import.meta.url)));
