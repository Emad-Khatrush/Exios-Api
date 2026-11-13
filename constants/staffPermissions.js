// What a staff member who is not an admin may open in the system (outside accounting, which has its
// own permissions in accounting/services/access.js). Admins and the owner accounts have everything.
// A key here is checked by middleware/permissions.js on the API and hides the page in the admin app;
// adding a page means adding its key here and in exios-admin/src/constants/staffPermissions.ts.
const PERMISSION_GROUPS = [
  {
    key: 'orders',
    label: 'الفواتير والطلبيات',
    permissions: [
      { key: 'invoices_create', label: 'إنشاء الفواتير وأرقام التتبع', hint: 'فاتورة جديدة، إضافة أرقام تتبع، رفع ملفات الطلبية' },
      { key: 'invoices_edit', label: 'تعديل الفواتير والطرود', hint: 'تعديل الفاتورة وأصنافها وطرودها وحالتها وأنشطتها' },
      { key: 'invoices_payments', label: 'استلام دفعات الفواتير', hint: 'تسجيل دفعة على فاتورة أو خصمها من المحفظة' },
      { key: 'invoices_cancel', label: 'إلغاء الطلبيات والفواتير', hint: 'إلغاء طلبية أو فاتورة صادرة' },
      { key: 'invoices_list', label: 'قائمة الفواتير والتقرير اليومي', hint: 'كل الفواتير، والفواتير الصادرة يومياً' },
      { key: 'tracking', label: 'X-Tracking ومتابعة الطلبيات', hint: 'متابعة مراحل الطلبيات والتحكم بها' },
      { key: 'delivery', label: 'تسليم الطرود للعملاء', hint: 'تسليم الطرود وإيقاف شحن طلبية' },
    ],
  },
  {
    key: 'money',
    label: 'العملاء والمال',
    permissions: [
      { key: 'clients', label: 'العملاء', hint: 'قائمة العملاء، تعديل بياناتهم ورقم العميل' },
      { key: 'passports', label: 'توثيق جوازات السفر', hint: 'قبول أو رفض جوازات العملاء' },
      { key: 'special_prices', label: 'الأسعار الخاصة', hint: 'أسعار شحن خاصة لعملاء محددين' },
      { key: 'wallets', label: 'المحافظ والصرافة', hint: 'الإيداع في محفظة العميل، السحب، الصرافة، قائمة المحافظ' },
      { key: 'debts', label: 'الديون', hint: 'ديون العملاء وتسديدها وإقفالها' },
      { key: 'returned_payments', label: 'المبالغ المرجعة', hint: 'المبالغ المرجعة من الموردين' },
      { key: 'expenses', label: 'مصروفات المكتب', hint: 'عرض وتسجيل مصروفات المكتب' },
    ],
  },
  {
    key: 'warehouse',
    label: 'المخزن والرحلات',
    permissions: [
      { key: 'inventory', label: 'الرحلات', hint: 'إنشاء الرحلات وتعديلها وتحميل الطرود عليها' },
      { key: 'warehouse', label: 'المخزن', hint: 'بضائع المخزن، الشحن الداخلي، جرد المخزن' },
    ],
  },
  {
    key: 'sales',
    label: 'المبيعات والتسويق',
    permissions: [
      { key: 'marketing', label: 'التسويق والحملات', hint: 'العملاء غير النشطين وإرسال حملات واتساب' },
      { key: 'goals', label: 'إدارة أهداف المبيعات', hint: 'تحديد أهداف المكاتب ومكافآتها' },
      { key: 'analytics', label: 'إحصاءات الزيارات', hint: 'زيارات الموقع والتطبيق' },
      { key: 'ratings', label: 'تقييمات العملاء', hint: 'تقييمات العملاء للطلبيات' },
    ],
  },
  {
    key: 'management',
    label: 'الإدارة',
    permissions: [
      { key: 'tasks', label: 'المهام', hint: 'مهامي، وإنشاء مهام للموظفين' },
      { key: 'reports', label: 'التقارير', hint: 'التقرير الشهري وتقرير أودو' },
      { key: 'activities', label: 'سجل النشاطات', hint: 'من فعل ماذا في النظام' },
      { key: 'settings_prices', label: 'الأسعار وسعر الصرف', hint: 'أسعار الشحن للعملاء وسعر صرف الدولار' },
      { key: 'settings_content', label: 'الإعلانات والمنشورات', hint: 'الإعلانات والمنشورات والنوافذ المنبثقة في تطبيق العميل' },
    ],
  },
];

const STAFF_KEYS = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => p.key));

// The kind of work a staff member does, each with the permissions it starts with. The type only
// fills the boxes: what is saved for the person is what decides.
const STAFF_TYPES = [
  {
    key: 'data_entry',
    label: 'مدخل بيانات',
    permissions: ['invoices_create', 'invoices_edit', 'tracking', 'clients', 'tasks'],
  },
  {
    key: 'accountant',
    label: 'محاسب',
    permissions: ['invoices_list', 'invoices_payments', 'clients', 'passports', 'wallets', 'debts', 'returned_payments', 'expenses', 'reports', 'tasks'],
  },
  {
    key: 'cashier',
    label: 'أمين خزينة',
    permissions: ['invoices_payments', 'delivery', 'clients', 'wallets', 'debts', 'returned_payments', 'expenses', 'tasks'],
  },
  {
    key: 'sales',
    label: 'مبيعات',
    permissions: ['invoices_create', 'tracking', 'clients', 'special_prices', 'marketing', 'ratings', 'tasks'],
  },
  {
    key: 'warehouse',
    label: 'موظف مخزن',
    permissions: ['invoices_edit', 'tracking', 'delivery', 'inventory', 'warehouse', 'tasks'],
  },
];
const STAFF_TYPE_KEYS = STAFF_TYPES.map((type) => type.key);

module.exports = { PERMISSION_GROUPS, STAFF_KEYS, STAFF_TYPES, STAFF_TYPE_KEYS };
