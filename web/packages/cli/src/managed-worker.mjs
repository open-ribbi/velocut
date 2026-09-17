import {startStudio} from './server.mjs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--port'||!/^\d+$/.test(args[1]))throw Error('Expected --port NUMBER');
const app=await startStudio({port:Number(args[1]),open:false,managed:true});
process.on('SIGTERM',()=>void app.close());
process.on('SIGINT',()=>void app.close());
