// Recognisable merchants, not countries or payment gateways. Unknown merchants are
// learned only after the operator approves their invoice/vendor association.
const merchants = [
  ['Alibaba', ['alibaba', 'alibaba.com']], ['1688', ['1688', '1688.com']],
  ['Taobao', ['taobao', 'world.taobao.com']], ['Tmall', ['tmall']],
  ['AliExpress', ['aliexpress']], ['Temu', ['temu']], ['Shein', ['shein']],
  ['JD.com', ['jd.com', 'jingdong']], ['Pinduoduo', ['pinduoduo']],
  ['DHgate', ['dhgate']], ['Made-in-China', ['made-in-china.com']],
  ['Global Sources', ['globalsources.com', 'global sources']],
  ['Banggood', ['banggood']], ['Geekbuying', ['geekbuying']],
  ['LightInTheBox', ['lightinthebox']], ['YesStyle', ['yesstyle']],
  ['Chinavasion', ['chinavasion']], ['Tomtop', ['tomtop']],
  ['Amazon', ['amazon', 'amzn']], ['eBay', ['ebay']], ['iHerb', ['iherb']],
  ['Walmart', ['walmart']], ['Trendyol', ['trendyol']], ['Hepsiburada', ['hepsiburada']],
  ['Noon', ['noon']], ['Namshi', ['namshi']], ['Ounass', ['ounass']],
  ['6thStreet', ['6thstreet']], ['Centrepoint', ['centrepoint']],
  ['Max Fashion', ['maxfashion']], ['Splash', ['splashfashions']],
  ['Jarir', ['jarir']], ['eXtra', ['extra.com', 'united electronics']],
  ['Xcite', ['xcite']], ['Sharaf DG', ['sharafdg', 'sharaf dg']],
  ['Jumbo', ['jumbo.ae', 'jumbo electronics']], ['Carrefour', ['carrefour']],
  ['Lulu', ['luluhypermarket', 'lulu hypermarket']], ['Desertcart', ['desertcart']],
  ['Ubuy', ['ubuy']], ['Boutiqaat', ['boutiqaat']], ['Taw9eel', ['taw9eel']],
  ['IKEA', ['ikea', 'ikea.cn']],
  ['Nice One', ['niceone']], ['Golden Scent', ['goldenscent', 'golden scent']],
  ['Eyewa', ['eyewa']], ['Sivvi', ['sivvi']], ['Styli', ['styli']],
].map(([name, bankAliases]) => ({ name, bankAliases, type: 'supplier',
  seedKey: `merchant:${bankAliases[0]}`, defaultCurrency: 'USD' }));
merchants.push(
  { name: 'Esra Bahcali', bankAliases: ['esra bahcali'], type: 'service', seedKey: 'merchant:esra-bahcali',
    defaultCurrency: 'TRY', bankAccountCode: '531700', bankOffice: 'turkey', note: 'خدمات محاسبة في تركيا؛ رسوم غرفة التجارة تصنف حسب وصف الحركة والمستند.' },
  { name: 'YalukII', bankAliases: ['yalukii', 'yalukll', 'yaluk ii', 'yaluk ll', 'yaluk'], type: 'service',
    seedKey: 'merchant:yalukii', defaultCurrency: 'CNY', bankPurpose: 'china_services', bankAccountCode: '531700', bankOffice: 'china',
    note: 'خدمات الصين: زيارة مصانع وإرسال شاحنات وغيرها. الفاتورة المرتبطة تحدد تحميل التكلفة على الطلبية أو الرحلة.' },
  { name: 'AlQFILA', bankAliases: ['alqfila', 'al qfila', 'alqafila', 'al qafila'], type: 'service',
    seedKey: 'merchant:alqfila', defaultCurrency: 'USD', bankPurpose: 'yuan_purchase',
    note: 'وسيط شراء اليوان؛ تسجل العملية من Alipay وتطابق حركة البنك مع قيدها، دون إنشاء تكلفة بضائع.' },
);
module.exports = merchants;
