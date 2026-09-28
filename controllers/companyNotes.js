const CompanyNote = require('../models/companyNote');
const ErrorHandler = require('../utils/errorHandler');
const { uploadToGoogleCloud, deleteFromGoogleCloud } = require('../utils/googleClould');

const uploadNoteFiles = async (files = []) => {
  const uploaded = [];
  for (const file of files) {
    const result = await uploadToGoogleCloud(file, 'exios-company-notes');
    if (!result.publicUrl) continue;
    uploaded.push({
      path: result.publicUrl,
      name: file.originalname,
      fileType: file.mimetype,
      size: file.size,
    });
  }
  return uploaded;
};

// Pinned notes first, then the most recently updated.
module.exports.getCompanyNotes = async (req, res, next) => {
  try {
    const notes = await CompanyNote.find({})
      .sort({ isPinned: -1, updatedAt: -1 })
      .populate('createdBy', 'firstName lastName');
    res.status(200).json(notes);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// Multipart: title, content, isPinned + optional `files`.
module.exports.createCompanyNote = async (req, res, next) => {
  try {
    const { title, content, isPinned } = req.body;

    if (!title || !String(title).trim()) {
      return next(new ErrorHandler(400, 'Title is required'));
    }

    const files = await uploadNoteFiles(req.files);
    const note = await CompanyNote.create({
      title: String(title).trim(),
      content: content || '',
      isPinned: isPinned === true || isPinned === 'true',
      files,
      createdBy: req.user._id,
    });

    res.status(201).json(note);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// Multipart: updates the text fields and appends any new `files`.
module.exports.updateCompanyNote = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, content, isPinned } = req.body;

    const note = await CompanyNote.findById(id);
    if (!note) {
      return next(new ErrorHandler(404, 'Note not found'));
    }

    if (title !== undefined) {
      if (!String(title).trim()) {
        return next(new ErrorHandler(400, 'Title is required'));
      }
      note.title = String(title).trim();
    }
    if (content !== undefined) note.content = content;
    if (isPinned !== undefined) note.isPinned = isPinned === true || isPinned === 'true';

    const files = await uploadNoteFiles(req.files);
    note.files.push(...files);

    await note.save();
    await note.populate('createdBy', 'firstName lastName');
    res.status(200).json(note);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.deleteCompanyNote = async (req, res, next) => {
  try {
    const note = await CompanyNote.findByIdAndDelete(req.params.id);
    if (!note) {
      return next(new ErrorHandler(404, 'Note not found'));
    }
    await Promise.all(note.files.map((file) => deleteFromGoogleCloud(file.path)));
    res.status(200).json({ success: true });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.deleteCompanyNoteFile = async (req, res, next) => {
  try {
    const { id, fileId } = req.params;
    const note = await CompanyNote.findById(id);
    if (!note) {
      return next(new ErrorHandler(404, 'Note not found'));
    }

    const file = note.files.id(fileId);
    if (!file) {
      return next(new ErrorHandler(404, 'File not found'));
    }

    await deleteFromGoogleCloud(file.path);
    file.deleteOne();
    await note.save();
    await note.populate('createdBy', 'firstName lastName');
    res.status(200).json(note);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};
