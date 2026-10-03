import {fileURLToPath} from 'node:url';
import {savePrivateAzureEnv} from '../lib/private-env.mjs';
try{await savePrivateAzureEnv(fileURLToPath(new URL('../',import.meta.url)),{endpoint:process.env.AZURE_OPENAI_ENDPOINT,deployment:process.env.AZURE_OPENAI_DEPLOYMENT,key:process.env.AZURE_OPENAI_API_KEY});console.log('Saved private .env with owner-only permissions. No key was printed or backed up.');}catch(e){console.error(e.message);process.exitCode=1;}
