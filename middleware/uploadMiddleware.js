// middlewares/uploadMiddleware.js
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');

// simple memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

function uploadToCloudinary(buffer, folder = 'trebetta/kyc') {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

// middleware for single doc + single selfie (fields: document, selfie)
async function kycUploadHandler(req, res, next) {
  try {
    // multer parsed files on req.files
    // Expecting fields: document (file), selfie (file)
    const uploads = [];
    if (req.files && req.files.document && req.files.document[0]) {
      uploads.push(
        uploadToCloudinary(req.files.document[0].buffer, 'trebetta/kyc/documents')
          .then(r => ({ key: 'document', url: r.secure_url }))
      );
    }
    if (req.files && req.files.selfie && req.files.selfie[0]) {
      uploads.push(
        uploadToCloudinary(req.files.selfie[0].buffer, 'trebetta/kyc/selfies')
          .then(r => ({ key: 'selfie', url: r.secure_url }))
      );
    }

    const results = await Promise.all(uploads);
    // attach urls to req.body so controller can consume
    for (const r of results) {
      if (r.key === 'document') req.body.document_url = r.url;
      if (r.key === 'selfie') req.body.selfie_url = r.url;
    }
    return next();
  } catch (err) {
    console.error('kycUploadHandler error', err);
    return res.status(500).json({ message: 'Upload error', error: err.message });
  }
}

module.exports = {
  upload, // multer instance for route definitions
  kycUploadHandler,
};
