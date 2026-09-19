import {workerData,parentPort} from 'node:worker_threads';
import {connect} from '../src/database.mjs';
import {Pos} from '../src/pos.mjs';
import {DEMO} from '../src/demo.mjs';
const db=connect(workerData.filename);const pos=new Pos(db);parentPort.postMessage({ready:true});
const gate=new Int32Array(workerData.startGate);Atomics.wait(gate,0,0,10000);
try{
  const result=pos.sell(DEMO.manager,workerData.key,{storeId:DEMO.storeA,cashSessionId:workerData.cashId,items:[{productId:workerData.productId,quantity:1}],discountCents:0,tenderedCents:100});
  parentPort.postMessage({result:{ok:true,id:result.data.id}});
}catch(error){parentPort.postMessage({result:{ok:false,code:error.code,message:error.message}});}
finally{db.close();}
