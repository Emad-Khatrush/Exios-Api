const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { reportBrowserOptions } = require('./reportBrowser');

const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const amount = value => number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const date = value => !value || Number.isNaN(new Date(value).getTime()) ? '—'
  : new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul' }).format(new Date(value));
const currency = value => ({ USD: 'دولار أمريكي', LYD: 'دينار ليبي' }[value] || value || '—');
const country = value => ({ CN: 'الصين', TR: 'تركيا', UAE: 'الإمارات', USA: 'الولايات المتحدة', UK: 'المملكة المتحدة', LY: 'ليبيا' }[value] || value || '—');
const office = value => ({ tripoli: 'طرابلس', benghazi: 'بنغازي' }[value] || value || '—');
const shipping = inventory => {
  const type = { air: 'جوي', sea: 'بحري', domestic: 'شحن داخلي' }[inventory.shippingType] || '—';
  const container = { lcl: 'حاوية مشتركة', fcl: 'حاوية كاملة' }[inventory.seaType];
  return `${type}${inventory.shippingType === 'sea' && container ? ` · ${container}` : ''}`;
};
const asset = (filename, mime) => `data:${mime};base64,${fs.readFileSync(filename).toString('base64')}`;
const fontUri = () => asset(path.join(__dirname, '..', 'NotoSansArabic.ttf'), 'font/ttf');

const renderFlightReportHtml = (inventory, orders, { customerOnly = false } = {}) => {
  const rows = orders.map(order => {
    const delivered = order.paymentList?.deliveredPackages || {};
    return { order, delivered, weight: number(delivered.weight?.total), unit: delivered.weight?.measureUnit || '' };
  });
  const total = unit => rows.filter(row => row.unit === unit).reduce((sum, row) => sum + row.weight, 0);
  const fees = rows.reduce((sum, row) => sum + row.weight * number(row.delivered.exiosPrice), 0);
  const boxes = rows.reduce((sum, row) => sum + number(row.delivered.boxesCount), 0);
  const logo = asset(path.join(__dirname, '..', 'assets', 'exios-logo.png'), 'image/png');
  const detail = (label, value, numeric = false) => `<div class="detail"><dt>${escape(label)}</dt><dd dir="${numeric ? 'ltr' : 'auto'}">${escape(value || '—')}</dd></div>`;
  const metric = (label, value, unit, highlight = false) => `<div class="metric${highlight ? ' highlight' : ''}"><span>${escape(label)}</span><strong dir="ltr">${escape(value)}</strong><small>${escape(unit)}</small></div>`;
  const packages = rows.map(({ order, delivered, weight, unit }, index) => {
    const name = order.customerInfo?.fullName || [order.user?.firstName, order.user?.lastName].filter(Boolean).join(' ') || '—';
    return `<tr><td class="row-number" dir="ltr">${index + 1}</td><td class="mono" dir="ltr">${escape(order.orderId || '—')}</td>
      <td><strong dir="auto">${escape(name)}</strong><div class="secondary mono" dir="ltr">${escape(order.user?.customerId || '—')}</div><div class="secondary mono" dir="ltr">${escape(order.customerInfo?.phone || order.user?.phone || '')}</div></td>
      <td class="mono" dir="ltr">${escape(delivered.trackingNumber || '—')}</td><td dir="auto">${escape(delivered.boxesCount ?? '—')}</td>
      <td><span dir="ltr" class="numeric">${amount(weight)}</span><small class="unit">${escape(unit === 'KG' ? 'كغ' : unit === 'CBM' ? 'م³' : unit || '—')}</small></td>
      <td class="numeric" dir="ltr">${amount(delivered.exiosPrice)}</td><td class="numeric total-cell" dir="ltr">${amount(weight * number(delivered.exiosPrice))}</td></tr>`;
  }).join('');
  const expenses = (inventory.expenses || []).map(exp => `<tr><td dir="ltr">${date(exp.date)}</td><td dir="auto">${escape(exp.description || '—')}</td><td class="numeric" dir="ltr">${amount(exp.amount)}</td><td>${escape(currency(exp.currency))}</td><td dir="ltr">${exp.rate > 0 ? escape(exp.rate) : '—'}</td></tr>`).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير الرحلة ${escape(inventory.voyage || '')}</title><style>
    @font-face { font-family: ReportArabic; src: url('${fontUri()}') format('truetype'); }
    * { box-sizing: border-box; }
    body { margin: 0; font: 12px/1.65 ReportArabic, Arial, sans-serif; color: #172d35; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .hero { display: flex; justify-content: space-between; align-items: center; border-top: 5px solid #00a88b; padding: 20px 0 18px; border-bottom: 1px solid #dbe7e6; }
    .brand { width: 155px; height: 74px; object-fit: contain; }
    .title { text-align: left; }
    h1 { font-size: 27px; line-height: 1.5; margin: 0 0 3px; font-weight: 700; color: #103d39; }
    .subtitle { color: #687f83; font-size: 11px; }
    .flight-id { margin-top: 9px; display: inline-flex; align-items: center; gap: 12px; padding: 6px 14px; background: #eaf7f3; border-radius: 9px; color: #086e5b; }
    .flight-id strong { font-size: 17px; }
    .details { display: grid; grid-template-columns: repeat(3, 1fr); gap: 13px 24px; padding: 19px 0; margin: 0; }
    .detail dt { font-size: 10px; color: #687f83; margin-bottom: 3px; }
    .detail dd { margin: 0; font-size: 12px; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 3px 0 24px; break-inside: avoid; }
    .metric { border: 1px solid #dbe7e6; background: #f6faf9; border-radius: 12px; padding: 13px 16px; }
    .metric span, .metric small { display: block; font-size: 10px; color: #687f83; }
    .metric strong { display: block; font: bold 25px/1.5 Arial, sans-serif; text-align: right; margin: 3px 0; }
    .metric.highlight { background: #eaf7f3; border-color: #c8e9df; color: #086e5b; }
    .section-title { display: flex; align-items: center; gap: 10px; margin: 22px 0 11px; break-after: avoid; }
    h2 { font-size: 15px; margin: 0; color: #103d39; }
    .count { font-size: 10px; background: #edf3f3; border-radius: 20px; padding: 2px 10px; color: #567478; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10px; }
    thead { display: table-header-group; }
    th { background: #103d39; color: #fff; font-weight: 600; padding: 11px 7px; text-align: right; font-size: 10px; }
    th small { display: block; font-weight: normal; color: #c8e5df; font-size: 8px; }
    td { border-bottom: 1px solid #e2ecea; padding: 10px 7px; vertical-align: top; overflow-wrap: anywhere; text-align: right; }
    tr { break-inside: avoid; }
    tbody tr:nth-child(even) { background: #f6faf9; }
    td strong { display: block; font-weight: 600; }
    .mono, .numeric { font-family: Arial, sans-serif; }
    .numeric { font-variant-numeric: tabular-nums; }
    .secondary, .unit { display: block; color: #687f83; font-size: 9px; margin-top: 2px; }
    .row-number { color: #819591; }
    .total-cell { color: #086e5b; font-weight: bold; }
    .table-total { display: flex; justify-content: space-between; padding: 12px 14px; border-bottom: 2px solid #00a88b; background: #eaf7f3; font-weight: 600; break-inside: avoid; }
    .table-total strong { font: bold 15px Arial, sans-serif; }
    .costs { background: #f6faf9; padding: 0 16px; border-radius: 12px; break-inside: avoid; }
    .notes { white-space: pre-wrap; overflow-wrap: anywhere; background: #f6faf9; border-right: 3px solid #00a88b; padding: 13px 17px; font-size: 11px; }
    .empty { padding: 20px; background: #f6faf9; border-radius: 10px; text-align: center; color: #687f83; }
  </style></head><body>
    <header class="hero"><img class="brand" src="${logo}" alt="شعار شركة إكسيوس"><div class="title"><h1>تقرير الرحلة</h1><div class="subtitle">${customerOnly ? 'تفاصيل طرود العميل في الرحلة' : 'تفاصيل الرحلة وقائمة الطرود'}</div><div class="flight-id"><span>رقم الرحلة</span><strong dir="auto">${escape(inventory.voyage || '—')}</strong></div></div></header>
    <dl class="details">
      ${detail('نوع الشحن / الحاوية', shipping(inventory))}${detail('بلد الشحن', country(inventory.shippedCountry))}${detail('مكتب الاستلام', office(inventory.inventoryPlace))}
      ${detail('تاريخ إصدار التقرير', date(new Date()), true)}${detail('عدد الطرود', String(rows.length), true)}
    </dl>
    <div class="metrics">${metric('إجمالي الوزن', amount(total('KG')), 'كيلوغرام (كغ)')}${metric('إجمالي الحجم', amount(total('CBM')), 'متر مكعب (م³)')}${metric('إجمالي الصناديق', String(boxes), 'صندوق')}${metric('رسوم الشحن', amount(fees), 'دولار أمريكي', true)}</div>
    <div class="section-title"><h2>تفاصيل الطرود</h2><span class="count">${rows.length} طرد</span></div>
    ${rows.length ? `<table><colgroup><col style="width:4%"><col style="width:13%"><col style="width:23%"><col style="width:20%"><col style="width:8%"><col style="width:10%"><col style="width:10%"><col style="width:12%"></colgroup><thead><tr><th>م</th><th>رقم الطلبية</th><th>العميل</th><th>رقم التتبع</th><th>الصناديق</th><th>الوزن / الحجم</th><th>سعر الوحدة<small>دولار أمريكي</small></th><th>رسوم الشحن<small>دولار أمريكي</small></th></tr></thead><tbody>${packages}</tbody></table><div class="table-total"><span>إجمالي رسوم الشحن (دولار أمريكي)</span><strong dir="ltr">${amount(fees)}</strong></div>` : '<div class="empty">لا توجد طرود مسجلة في هذا التقرير.</div>'}
    ${customerOnly ? '' : `<div class="section-title"><h2>تكاليف الرحلة</h2></div><div class="costs"><dl class="details">${detail('التكلفة لكل وحدة وزن', amount(inventory.costPrice), true)}${detail('قيمة الرحلة', `${amount(inventory.voyageAmount)} ${currency(inventory.voyageCurrency)}`)}</dl></div><div class="section-title"><h2>المصروفات</h2></div>${expenses ? `<table><colgroup><col style="width:15%"><col style="width:40%"><col style="width:15%"><col style="width:15%"><col style="width:15%"></colgroup><thead><tr><th>التاريخ</th><th>الوصف</th><th>المبلغ</th><th>العملة</th><th>سعر الصرف<small>دينار لكل دولار</small></th></tr></thead><tbody>${expenses}</tbody></table>` : '<div class="empty">لا توجد مصروفات مسجلة.</div>'}`}
    ${inventory.note ? `<div class="section-title"><h2>الملاحظات</h2></div><div class="notes" dir="auto">${escape(inventory.note)}</div>` : ''}
  </body></html>`;
};

const buildFlightReport = async (inventory, orders, options = {}) => {
  const browser = await puppeteer.launch(reportBrowserOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(renderFlightReportHtml(inventory, orders, options), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: 'A4', landscape: true, printBackground: true,
      margin: { top: '12mm', bottom: '17mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<style>@font-face{font-family:ReportArabic;src:url('${fontUri()}')}</style><div dir="rtl" style="width:100%;margin:0 12mm;border-top:1px solid #dbe7e6;padding-top:6px;display:flex;justify-content:space-between;font:9px ReportArabic,Arial,sans-serif;color:#687f83"><span>إكسيوس · تقرير الرحلة</span><span>الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span></div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
};

module.exports = { buildFlightReport, renderFlightReportHtml };
