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
            return { isFinished: false,  unsureOrder: false, isCanceled: false }
        
        case 'shipment':
            return { isShipment: true,  unsureOrder: false, isPayment: false,  isFinished: false, isCanceled: false }
        
        case 'arriving':
            return { unsureOrder: false, isPayment: true,  orderStatus: 1, isCanceled: false }

        case 'arrivedWarehouse':
            return { $or: [{isPayment: true,  orderStatus: { $or: [2, 3] }, isCanceled: false }, {isPayment: false,  orderStatus: { $or: [1, 2] }, isCanceled: false }] }

        case 'readyForPickup':
            return { unsureOrder: false, $or: [{isPayment: true,  orderStatus: 4, isCanceled: false }, {isPayment: false,  orderStatus: 3, isCanceled: false }] }
        case 'unpaid':
            return { unsureOrder: false,  orderStatus: 0, isPayment: true, isCanceled: false }

        case 'finished':
            return { isFinished: true, isCanceled: false }

        case 'unsure':
            return { unsureOrder: true, isCanceled: false }

        case 'canceled':
            return { isCanceled: true };
    
        default:
            return { isFinished: false,  unsureOrder: false }
    }
}

exports.convertObjDataFromStringToNumberType = (obj) => {
    for (let prop in obj) {
        if (obj.hasOwnProperty(prop)) {
            obj[prop] = Number(obj[prop]);
        }
    }
    return obj;
}