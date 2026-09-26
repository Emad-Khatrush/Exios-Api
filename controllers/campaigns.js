const Campaign = require('../models/campaign');
const sendMessageQueue = require('../utils/messageQueue');
const ErrorHandler = require('../utils/errorHandler');

// Admin: list every campaign with summary progress (no per-user list - see getCampaign).
module.exports.getCampaigns = async (req, res, next) => {
  try {
    const campaigns = await Campaign.find({})
      .select('-users')
      .sort({ createdAt: -1 });

    res.status(200).json(campaigns);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// Admin: full detail for one campaign, including who was targeted and their send status.
module.exports.getCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const campaign = await Campaign.findById(id);

    if (!campaign) {
      return next(new ErrorHandler(404, 'Campaign not found'));
    }

    res.status(200).json(campaign);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// Admin: cancels any messages still queued for this campaign, then deletes the
// campaign record. Messages already sent stay sent - this only stops the rest.
module.exports.deleteCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const campaign = await Campaign.findById(id);

    if (!campaign) {
      return next(new ErrorHandler(404, 'Campaign not found'));
    }

    const pendingUserIds = new Set(
      campaign.users
        .filter((entry) => entry.status === 'pending')
        .map((entry) => String(entry.user))
    );

    if (pendingUserIds.size > 0) {
      const jobs = await sendMessageQueue.getJobs(['delayed', 'waiting']);
      await Promise.all(
        jobs
          .filter((job) => job.data?.campaignId === String(campaign._id) && pendingUserIds.has(String(job.data?.userId)))
          .map((job) => job.remove().catch(() => {}))
      );
    }

    await Campaign.findByIdAndDelete(id);

    res.status(200).json({ message: 'Campaign cancelled and deleted' });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};
