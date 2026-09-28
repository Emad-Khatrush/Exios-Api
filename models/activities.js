const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const activitySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User'},
  details: {
    path: { type: String },
    status:{ type: String, enum: ['added', 'updated', 'deleted'] }, // updated, deleted, added
    type: { type: String, enum: ['order', 'expense', 'activity', 'income', 'inventory', 'debt'] }, // order, expense, activity, income, inventory, debt
    actionName: { type: String, enum: ['image'] },
    actionId: String
  },
  changedFields: [{
    label: String,
    value: String,
    changedFrom: String,
    changedTo: String
  }]
}, 
{
  timestamps: true
})

// The activities page always sorts newest first and filters by date, type or person.
activitySchema.index({ createdAt: -1 });
activitySchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("Activity", activitySchema);
