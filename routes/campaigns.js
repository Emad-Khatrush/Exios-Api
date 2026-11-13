const express = require('express');
const campaigns = require('../controllers/campaigns');
const { protect, isAdmin } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');

const router = express.Router();

router.route('/campaigns')
      .get(protect, allow(['marketing'], isAdmin), campaigns.getCampaigns);

router.route('/campaigns/:id')
      .get(protect, allow(['marketing'], isAdmin), campaigns.getCampaign)
      .delete(protect, allow(['marketing'], isAdmin), campaigns.deleteCampaign);

module.exports = router;
