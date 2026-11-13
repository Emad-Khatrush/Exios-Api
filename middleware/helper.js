const { orderLabels } = require("../constants/orderLabels");

exports.generateString = (length, characters) => {
    let result = '';
    const charactersLength = characters.length;
    for ( let i = 0; i < length; i++ ) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }

    return result;
}

exports.addChangedField = (fieldName, newData, oldData, labels) => {
    switch (fieldName) {
        case 'debt':
            return {
                label: labels[fieldName],
                value: fieldName,
                changedFrom: `${oldData?.total || '0'} ${oldData?.currency || 'empty'}`,
                changedTo: `${newData?.total || '0'} ${newData?.currency || 'empty'}`
              }
        case 'credit':
        return {
            label: labels[fieldName],
            value: fieldName,
            changedFrom: `${oldData?.total || '0'} ${oldData?.currency || 'empty'}`,
            changedTo: `${newData?.total || '0'} ${newData?.currency || 'empty'}`
            }
        case 'cost':
        return {
            label: labels[fieldName],
            value: fieldName,
            changedFrom: `${oldData?.total || '0'} ${oldData?.currency || 'empty'}`,
            changedTo: `${newData?.total || '0'} ${newData?.currency || 'empty'}`
            }
        case 'paymentList':
            return {
                label: labels[fieldName],
                value: fieldName,
                changedFrom: String(oldData?.length) || 'empty',
                changedTo: String(newData?.length) || 'empty',
            }
        case 'items':
            return {
                label: labels[fieldName],
                value: fieldName,
                changedFrom: String(oldData?.length) || 'empty',
                changedTo: String(newData?.length) || 'empty',
            }

        case 'purchaseItems':
            return {
                label: labels[fieldName],
                value: fieldName,
                changedFrom: String(oldData?.length) || 'empty',
                changedTo: String(newData?.length) || 'empty',
            }
    
        default:
            return {
                label: labels[fieldName],
                value: fieldName,
                changedFrom: oldData || 'empty',
                changedTo: newData,
            }
    }
}

exports.getTapTypeQuery = (tapType) => {
    switch (tapType) {
        case 'active':
            return {
                isFinished: false,
                unsureOrder: false,
                isCanceled: false,
                $or: [
                    { isPayment: true, isShipment: true },       // both true
                    { isShipment: true, isPayment: false }       // shipment true & payment false
                ]
            }
        
        case 'shipment':
            return { isShipment: true,  unsureOrder: false, isPayment: false,  isFinished: false, isCanceled: false }
        
        case 'arriving':
            return { unsureOrder: false, isPayment: true,  orderStatus: 1, isCanceled: false }

        case 'arrivedWarehouse':
            return {
                unsureOrder: false,
                isCanceled: false,
                $and: [
                {
                    $or: [
                    {
                        isPayment: true,
                        orderStatus: { $in: [2, 3] }   // paid & arrived
                    },
                    {
                        isPayment: false,
                        orderStatus: { $in: [1, 2] }   // unpaid but partially arrived
                    }
                    ]
                },
                {
                    $or: [
                    { isPayment: true, isShipment: true },   // both true
                    { isShipment: true, isPayment: false }   // shipment true & payment false
                    ]
                }
                ]
            }

        case 'readyForPickup':
            return {
                unsureOrder: false,
                isCanceled: false,
                $and: [
                    {
                    $or: [
                        { isPayment: true, orderStatus: 4 },   // ✅ paid & ready
                        { isPayment: false, orderStatus: 3 }   // ✅ unpaid & ready
                    ]
                    },
                    {
                    $or: [
                        { isPayment: true, isShipment: true },   // both true
                        { isShipment: true, isPayment: false }   // shipment true & payment false
                    ]
                    }
                ]
            }
        case 'unpaid':
            return { unsureOrder: false,  orderStatus: 0, isPayment: true, isCanceled: false }

        case 'finished':
            return { isFinished: true, isCanceled: false, unsureOrder: false }

        case 'unsure':
            return { unsureOrder: true, isCanceled: false }

        case 'hasRemainingPayment':
            return { hasRemainingPayment: true }

        case 'hasProblem':
            return { hasProblem: true }

        case 'canceled':
            return { isCanceled: true };

        case 'invoiceOrders':
            return { unsureOrder: false, isPayment: true, isShipment: false };
    
        default:
            return { isFinished: false,  unsureOrder: false }
    }
}

// The only order fields a customer may read. The client app names the fields it wants in the query
// string, which must never be trusted as a projection: the order also holds cost prices
// (originPrice, originShipmentPrice), profit (netIncome), staff notes and accounting fields.
// Adding a field here is what makes it visible to customers.
const CLIENT_ORDER_FIELDS = [
    'orderId', 'createdAt', 'updatedAt', 'placedAt', 'orderStatus',
    'isPayment', 'isShipment', 'isFinished', 'isCanceled', 'unsureOrder',
    'productName', 'quantity', 'customerInfo', 'totalInvoice', 'debt', 'credit',
    'activity', 'images',
    'customization.note', 'customization.theme',
    'shipment.method', 'shipment.fromWhere', 'shipment.toWhere', 'shipment.estimatedDelivery',
    'shipment.weight', 'shipment.packageCount',
    'paymentList._id', 'paymentList.status', 'paymentList.images', 'paymentList.settings',
    'paymentList.deliveredPackages.arrivedAt', 'paymentList.deliveredPackages.trackingNumber',
    'paymentList.deliveredPackages.shipmentMethod', 'paymentList.deliveredPackages.weight',
    'paymentList.deliveredPackages.exiosPrice', 'paymentList.deliveredPackages.boxesCount',
    'paymentList.deliveredPackages.locationPlace', 'paymentList.deliveredPackages.deliveredInfo',
];

// Builds the projection for a customer's order query from the fields they asked for, keeping only
// allowed ones. Asking for a parent ('paymentList') gives its allowed children; asking for a field
// inside an allowed one ('customerInfo.phone') is kept. Nothing valid asked for: every allowed field.
// `exclude` drops allowed fields for one endpoint: the lists leave out the order's images, which only
// the single-order endpoint filters down to the customer's own receipts.
exports.buildClientOrderProjection = (requested = {}, exclude = []) => {
    const fields = CLIENT_ORDER_FIELDS.filter(field => !exclude.includes(field));
    const projection = {};
    for (const key of Object.keys(requested)) {
        if (key.includes('$')) continue;
        for (const allowed of fields) {
            if (key === allowed || key.startsWith(allowed + '.')) projection[key] = 1;
            else if (allowed.startsWith(key + '.')) projection[allowed] = 1;
        }
    }
    // A field and one of its own sub-fields together is a path collision in MongoDB: keep the parent
    for (const key of Object.keys(projection)) {
        if (Object.keys(projection).some(other => key.startsWith(other + '.'))) delete projection[key];
    }
    if (Object.keys(projection).length === 0) fields.forEach(field => { projection[field] = 1; });
    return projection;
}

exports.convertObjDataFromStringToNumberType = (obj) => {
    for (let prop in obj) {
        if (obj.hasOwnProperty(prop)) {
            obj[prop] = Number(obj[prop]);
        }
    }
    return obj;
}