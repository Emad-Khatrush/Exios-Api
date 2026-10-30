const moment = require('moment-timezone');
const { startDb, stopDb, resetDb, oid } = require('./helpers');
const Inventory = require('../../models/inventory');
const Order = require('../../models/order');
const goals = require('../../controllers/goals')._internals;
const { seaFields } = require('../../utils/tripSeaType');
beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);

test('master goals count accounting FCL trips and master fcl trips alike without counting their packages as LCL', async () => {
  const date = new Date('2026-10-10T12:00:00Z'), packages=[oid(),oid()];
  await Inventory.collection.insertMany(packages.map((id,i)=>({shippingType:'sea',...(i?{seaType:'fcl'}:{seaLoadType:'FCL'}),inventoryPlace:'tripoli',shippedCountry:'China',inventoryType:'inventoryGoods',createdAt:date,orders:[{paymentList:[{_id:id}]}]})));
  await Order.collection.insertMany(packages.map(id=>({orderId:String(id),isCanceled:false,unsureOrder:false,placedAt:'tripoli',createdAt:date,paymentList:[{_id:id,deliveredPackages:{arrivedAt:date,weight:{measureUnit:'CBM',total:3}}}]})));
  goals.clearCaches();
  const rows=await goals.actualRows(moment.tz('2026-10-10','Africa/Tripoli').startOf('day'),moment.tz('2026-10-10','Africa/Tripoli').endOf('day'));
  expect(rows.reduce((sum,row)=>sum+row.fcl,0)).toBe(2);
  expect(rows.reduce((sum,row)=>sum+row.lcl,0)).toBe(0);
});

test('trip creation/editing normalizes either master or accounting sea classification and refuses disagreements', () => {
  expect(seaFields({shippingType:'sea',seaType:'lcl'})).toEqual({seaType:'lcl',seaLoadType:'LCL'});
  expect(seaFields({note:'Edited'}, {shippingType:'sea',seaType:'fcl'})).toEqual({seaType:'fcl',seaLoadType:'FCL'});
  expect(seaFields({shippingType:'air'}, {shippingType:'sea',seaLoadType:'FCL'})).toEqual({seaType:null,seaLoadType:null});
  expect(()=>seaFields({shippingType:'sea',seaType:'fcl',seaLoadType:'LCL'})).toThrow();
});
