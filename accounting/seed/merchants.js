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
  ['Nice One', ['niceone']], ['Golden Scent', ['goldenscent', 'golden scent']],
  ['Eyewa', ['eyewa']], ['Sivvi', ['sivvi']], ['Styli', ['styli']],
].map(([name, bankAliases]) => ({ name, bankAliases, type: 'supplier',
  seedKey: `merchant:${bankAliases[0]}`, defaultCurrency: 'USD' }));
module.exports = merchants;
