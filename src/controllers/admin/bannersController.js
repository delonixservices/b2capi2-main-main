const Banner = require('../../models/Banner');
const { v1: uuidv1 } = require('uuid');
const fs = require('fs');
const path = require('path');
const logger = require('../../config/logger');

exports.addBanner = async (req, res, next) => {
  const id = req.body._id;
  const name = req.body.name;
  const from = req.body.from;
  const to = req.body.to;
  const url = req.body.url;

  let banner = new Banner();

  banner.name = name;
  banner.from = from;
  banner.to = to;
  banner.url = url;

  const image = req.file;

  if (id == "" && !image) {
    // throw BadRequestException.invoke(`Image required`);
  }

  if (image) {
    const uuid = uuidv1().replace(/-/g, '');
    const fileName = `${uuid}_${image.fieldname}`;

    let extension = path.extname(image.originalname);
    extension = extension ? extension : '.jpg';

    const filePath = `uploads/${fileName}${extension}`;
    banner.image = filePath;
    const fullPath = path.join(__dirname, `/../../../public/${filePath}`);

    fs.writeFile(fullPath, image.buffer, (err) => {
      console.log(err);
    });
  }

  try {
    await banner.save();
  } catch (err) {
    logger.error(`Mongodb error: ${err.message}`);
    return res.status(500).json({
      'message': 'Cannot add banner'
    });
  }

  res.json({
    "status": 200,
    data: banner
  });
};

exports.allBanners = async (req, res, next) => {
  const banners = await Banner.find({}, {
    'updated_at': 0,
    __v: 0
  });

  res.json({
    "status": 200,
    "data": banners
  });
};

exports.editBanner = async (req, res, next) => {
  const id = req.body._id;
  const name = req.body.name;
  const from = req.body.from;
  const to = req.body.to;
  const url = req.body.url;

  const banner = await Banner.findById(id);

  if (!banner) {
    return res.status(404).json({
      "message": "banner does not exists"
    });
  }

  banner.name = name;
  banner.from = from;
  banner.to = to;
  banner.url = url;

  const image = req.file;

  if (id == "" && !image) {
    // throw Error(`Image required`);
  }

  if (image) {
    const uuid = uuidv1().replace(/-/g, '');
    const fileName = `${uuid}_${image.fieldname}`;

    let extension = path.extname(image.originalname);
    extension = extension ? extension : '.jpg';

    const filePath = `uploads/${fileName}${extension}`;

    banner.image = filePath;

    const fullPath = path.join(__dirname, `/../../../public/${filePath}`);

    fs.writeFile(fullPath, image.buffer, (err) => {
      console.log(err);
    });
  }

  try {
    await banner.save();
  } catch (err) {
    logger.error(`Mongodb error: ${err.message}`);
    return res.status(500).json({
      'message': 'Cannot save banner'
    });
  }

  res.json({
    "status": 200,
    data: banner
  });
};

exports.deleteBanner = async (req, res, next) => {
  const id = req.query.id;
  const banner = await Banner.findByIdAndDelete(id);
  if (!banner) {
    return res.status(422).json({
      "message": "Unable to delete banner"
    });
  }

  res.json({
    "status": 200,
    "data": banner
  });

};