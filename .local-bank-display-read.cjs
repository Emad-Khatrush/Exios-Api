require('dotenv').config();
const mongoose=require('mongoose');
(async()=>{
 const uri=process.env.MONGO_URL_2||process.env.MONGO_URL;
 if(!['localhost','127.0.0.1','[::1]'].includes(new URL(uri).hostname))throw Error('Local read only');
 mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);
 require('./accounting/models');require('./accounting/models/documents');
 await mongoose.connect(uri,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:3000});
 const opening=await require('./accounting/services/roles').resolveAccount('opening_balance');
 const account=await require('./accounting/models').Account.findOne({code:'110201'}).lean();
 const rows=await require('./accounting/services/posting/bank').unmatchedMovements(account._id,{includeBalanceAdjustments:true});
 process.stdout.write(JSON.stringify({database:mongoose.connection.db.databaseName,openingAccount:{id:opening._id,code:opening.code},rows:rows.map(r=>({number:r.number,balanceAdjustment:r.balanceAdjustment,eventType:r.eventType,accounts:r.allAccountIds.map(String)}))}));
 await mongoose.disconnect();
})().catch(e=>{process.stderr.write(e.message);process.exitCode=1;mongoose.disconnect()});
