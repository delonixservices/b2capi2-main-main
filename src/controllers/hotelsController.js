/* eslint-disable no-unused-vars */
const Api = require('../services/apiService');
const Transaction = require('../models/HotelTransaction');
const User = require('../models/User');
const Hotel = require('../models/Hotel');
const BookingPolicy = require('../models/BookingPolicy');

const MetaSearch = require('../models/MetaSearch');

const logger = require('../config/logger');

const {
addMarkup,
getMarkup
} = require('../services/markupService');

const Config = require('../models/Config');

const jwt = require('jsonwebtoken');
const {
jwtSecret
} = require('../config/index');

const bcrypt = require('bcryptjs');

const Sms = require('../services/smsService');

const {
generateInvoice
} = require('../utils/invoice');
const {
generateVoucher
} = require('../utils/voucher');

const {redisAuth} = require("../config")
const { createClient } = require('redis');

exports.suggest = async (req, res, next) => {
const term = req.body.query;
let page = +req.body.page || 1;
let perPage = +req.body.perPage || 10;
let currentItemsCount = +req.body.currentItemsCount || 0;

if (perPage > 50) {
return res.status(400).json({ message: 'perPage should not be greater than 50' });
}

const defaultResponse = {
data: [],
status: 'complete',
currentItemsCount: 0,
totalItemsCount: 0,
page,
perPage,
totalPages: 0,
};

if (!term || term.length < 3) {
return res.json(defaultResponse);
}

const client = createClient({
socket: {
host: 'localhost',
port: 6379,
},
password: redisAuth,
});

client.on('error', (err) => console.error('Redis Client Error:', err));

let responseData = [];

try {
await client.connect();

const cachedData = await client.get(`autosuggest:${term}`);
const parsedData = cachedData ? JSON.parse(cachedData) : null;

if (Array.isArray(parsedData)) {
responseData = parsedData;
console.log('Served from Redis');
} else {
const data = await Api.hotels.post("/autosuggest", {
autosuggest: { query: term, locale: "en-US" }
});

if (data?.data) {
if (data.data.city) {
data.data.city.results.forEach(item => {
item.transaction_identifier = data.transaction_identifier;
item.displayName = `${item.name} | (${item.hotelCount})`;
responseData.push(item);
});
}

if (data.data.hotel) {
data.data.hotel.results.forEach(item => {
item.transaction_identifier = data.data.transaction_identifier;
item.displayName = `${item.name}`;
responseData.push(item);
});
}

if (data.data.poi) {
data.data.poi.results.forEach(item => {
item.transaction_identifier = data.data.transaction_identifier;
item.displayName = `${item.name} | (${item.hotelCount})`;
responseData.push(item);
});
}

if (responseData.length > 0) {
await client.set(`autosuggest:${term}`, JSON.stringify(responseData), { EX: 7200 });
}
}
}
} catch (err) {
console.error('Error in suggest:', err);

try {
await client.del(`autosuggest:${term}`);
console.log("Redis cache deleted due to error.");
} catch (delErr) {
console.log("Cannot delete cache", delErr);
}

return next(err);
} finally {
await client.quit();
}

const nextItemsCount = Math.min(page * perPage, responseData.length);
const totalPages = Math.ceil(responseData.length / perPage);

if (page > totalPages) {
return res.json(defaultResponse);
}

const pollingStatus = page === totalPages ? "complete" : "in-progress";
const lowerBound = currentItemsCount;
let upperBound = lowerBound + perPage;
if (upperBound > responseData.length + 1) upperBound = responseData.length + 1;

const selectedItems = responseData.slice(lowerBound, upperBound);

return res.json({
data: selectedItems,
status: pollingStatus,
currentItemsCount: nextItemsCount,
totalItemsCount: responseData.length,
page,
perPage,
totalPages
});
};


exports.searchHotels = async (req, res, next) => {

const details = req.body.details;
const area = req.body.area;
const checkInDate = req.body.checkindate;
const checkOutDate = req.body.checkoutdate;
const transaction_identifier = req.body.transaction_identifier;

const filters = req.body.filters || {};

let page = +req.body.page;

let perPage = +req.body.perPage;

let currentHotelsCount = +req.body.currentHotelsCount;

console.log('currentHotelsCount ' + currentHotelsCount)

if (!page || page < 1) {
page = 1;
}

// minimum hotels allowed = 10
if (!perPage || perPage < 10) {
perPage = 10;
}

// maximum hotels allowed at one time = 50
if (perPage > 50) {
return res.status(400).json({
'message': 'perPage should not be greater than 50'
})
}

if (!currentHotelsCount || currentHotelsCount < 0) {
currentHotelsCount = 0;
}

if (!details || !Array.isArray(details)) {
return res.status(400).json({
'message': 'Validation failed! Invalid details array'
})
}

// transaction identifier not necessary for some requests

// if (!transaction_identifier) {
// return res.status(400).json({
// 'message': 'Validation failed! transaction_identifier is missing'
// })
// }

let total_adult = 0;
let total_child = 0;
let i = 0;
for (let room of details) {
total_adult = total_adult + Number(room.adult_count);
if (Number(room.child_count) > 0) {
total_child = total_child + Number(room.child_count);
} else {
delete details[i].child_count;
delete details[i].children;
}
i = i + 1;
}

// console.log(checkInDate, checkOutDate, total_adult, total_child, area.id, area.type, area.name);
const searchObj = {
  search: {
    source_market: "IN",
    type: area.type,
    id: area.id,
    name: area.name,
    check_in_date: checkInDate,
    check_out_date: checkOutDate,
    total_adult_count: total_adult.toString(),
    total_child_count: total_child.toString(),
    total_room_count: details.length.toString(),
    details: details
  }
};

if (transaction_identifier && transaction_identifier !== "undefined") {
  searchObj.search.transaction_identifier = transaction_identifier;
}

console.log(searchObj);

let data;

try {
  await client.connect(); // Ensure Redis client is connected

  try {
    await client.auth(redisAuth);
    console.log("Redis authenticated");
  } catch (err) {
    console.error("Redis auth error:", err);
  }

  client.get = util.promisify(client.get);

  let cachedData;
  let redisKey = { ...searchObj.search };
  delete redisKey.transaction_identifier;

  // Stringify search object to create a stable key
  redisKey = JSON.stringify(redisKey);

  try {
    console.log("Checking Redis for key:", redisKey);
    cachedData = await client.get(`hotels_search:${redisKey}`);
  } catch (err) {
    console.error("Redis get error:", err);
  }

  if (cachedData) {
    data = JSON.parse(cachedData);
    console.log("Served from Redis cache");
  } else {
    data = await Api.hotels.post("/search", searchObj);
    console.log("Served from API");

    if (data.data && data.data.totalHotelsCount >= 1) {
      try {
        await client.set(`hotels_search:${redisKey}`, JSON.stringify(data), 'EX', 300);
        console.log("Data cached in Redis");
      } catch (err) {
        console.error("Redis set error:", err);
      }
    }
  }
} catch (err) {
  // Fallback if Redis fails
  try {
    data = await Api.hotels.post("/search", searchObj);
    console.log("Served from API fallback");

    if (data.data && data.data.totalHotelsCount >= 1) {
      const redisKey = JSON.stringify({ ...searchObj.search, transaction_identifier: undefined });
      client.set(`hotels_search:${redisKey}`, JSON.stringify(data), 'EX', 300, (err) => {
        if (err) console.error("Redis set error (fallback):", err);
      });
      console.log("Data cached (fallback)");
    }
  } catch (apiErr) {
    return next(apiErr);
  }
}

if (!data?.data) {
  console.log(data);
  return res.status(404).send("No Hotels Found");
}

if (data.data.hotels.length < 1) {
  console.log("Error: No hotels found");
  console.log(data);
  return res.status(404).send("No hotels found");
}

// Proceed with hotel data
let hotelsList = [...data.data.hotels];
console.log(hotelsList);


// ==================================
// ======== TESTING - START =========
// ==================================

// copy same hotel multiple times to test pagination

// const tempHotels = [];

// for (let i = 0; i < 50; i++) {
// tempHotels.push(hotelsList[0]);
// }

// hotelsList = tempHotels;

// ==================================
// ========= TESTING - END ==========
// ==================================

const nextHotelsCount = page * perPage > hotelsList.length ? hotelsList.length : page * perPage;

const paginaionObj = {
'currentHotelsCount': nextHotelsCount,
'totalHotelsCount': hotelsList.length,
'totalPages': Math.ceil(hotelsList.length / perPage),
'pollingStatus': ''
}

let pollingStatus;

if (page > paginaionObj.totalPages) {
return res.status(422).json({
'message': 'Invalid page no'
})
}

if (page === paginaionObj.totalPages) {
pollingStatus = "complete";
} else {
pollingStatus = "in-progress";
}

paginaionObj.pollingStatus = pollingStatus;

let lowerBound = currentHotelsCount;

let upperBound = lowerBound + perPage;

// upperBound should not be greated than totalHotels + 1
if (upperBound > paginaionObj.totalHotelsCount + 1) {
upperBound = paginaionObj.totalHotelsCount + 1;
}

console.log(paginaionObj);
console.log(page);
console.log(perPage);
console.log(lowerBound);
console.log(upperBound);

// select only requested no of hotels in current iteration
const selectedHotels = hotelsList.slice(lowerBound, upperBound);

// console.log(selectedHotels);

let hotels;
let minPrice = 0;
let maxPrice = 1;

try {
// hotels = await Hotel.insertMany(data.data.hotels);
hotels = await Hotel.insertMany(selectedHotels);

const promiseArray = hotels.map(async (hotel) => {
// console.log('total packages: ', hotel.rates.packages.length);
hotel.hotelId = hotel._id;
// delete hotel._id;
// Add markup
const hotelPackage = hotel.rates.packages[0];

// console.log(hotelPackage);
try {
// addMarkup method will apply markup and other charges on hotelPackage
await addMarkup(hotelPackage);
} catch (err) {
throw err;
}
if (hotelPackage.base_amount < minPrice) {
minPrice = hotelPackage.base_amount;
}
if (hotelPackage.base_amount > maxPrice) {
maxPrice = hotelPackage.base_amount;
}

return hotel;
});

const allHotels = await Promise.all(promiseArray);
// console.log(hotels)
const filteredHotels = [];
console.log(allHotels);
console.log(filters);
allHotels.forEach((hotel) => {
// hotel filters
if (filters.roomType && filters.roomType.length > 0) {
let flag = false;
hotel.rates.packages.forEach((pkg) => {
if (filters.roomType.includes(pkg.room_details.room_type)) {
flag = true;
return;
}
});
console.log('0', flag);
if (!flag) return;
}
if (filters.foodType && filters.foodType.length > 0) {
let flag = false;
hotel.rates.packages.forEach((pkg) => {
if (filters.foodType.includes(pkg.room_details.food)) {
flag = true;
return;
}
});
console.log('1', flag);
if (!flag) return;
}
if (filters.refundable && filters.refundable.length > 0) {
let isNonRefundable = hotel.rates.packages[0].room_details.non_refundable;
if (isNonRefundable === undefined) {
isNonRefundable = true;
}
// checking for refundable
const flag = filters.refundable.includes(!isNonRefundable);
console.log('2', flag);
if (!flag) return;
}
if (filters.starRating && filters.starRating.length > 0) {
let starRating = hotel.starRating;
if (!starRating) {
starRating = 0;
}
const flag = filters.starRating.includes(starRating);
console.log('3', flag);
if (!flag) return;
}

if (filters.price && filters.price.min >= 0 && filters.price.max > 0) {
const flag = hotel.rates.packages[0].base_amount >= filters.price.min && hotel.rates.packages[0].base_amount <= filters.price.max;
if (!flag) return;
}
filteredHotels.push(hotel);
});

console.log(filteredHotels);

hotels = filteredHotels;

} catch (err) {
console.log(err);
return res.status(500).json({
"message": "Error in generating response!"
});
}

const dataObj = {
'data': {
'search': data.data.search,
'region': data.data.region,
'hotels': hotels,
'price': {
minPrice: Math.floor(minPrice),
maxPrice: Math.ceil(maxPrice)
},
'currentHotelsCount': paginaionObj.currentHotelsCount,
'totalHotelsCount': paginaionObj.totalHotelsCount,
'page': page,
'perPage': perPage,
'totalPages': paginaionObj.totalPages,
'status': paginaionObj.pollingStatus,
'transaction_identifier': data.transaction_identifier
}
}

console.log(dataObj);
res.json(dataObj);
}

exports.searchPackages = async (req, res, next) => {

const checkInDate = req.body.checkindate;
const checkOutDate = req.body.checkoutdate;
// const area = req.body.area;
const details = req.body.details;
const hotelId = req.body.hotelId;

// also allow req if there is no transaction identifier
const transaction_identifier = req.body.transaction_identifier;

const referenceId = req.body.referenceId;

if (!hotelId || !checkInDate || !checkOutDate || !details) {
return res.status(400).json({
'message': 'validation failed!'
})
}

const hotel = await Hotel.findById(hotelId);

if (!hotel) {
return res.status(404).json({
'message': 'Hotel not found!!'
});
}

let total_adult = 0;
let total_child = 0;
let i = 0;
for (let room of details) {
total_adult = total_adult + Number(room.adult_count);
if (Number(room.child_count) > 0) {
total_child = total_child + Number(room.child_count);
} else {
delete details[i].child_count;
delete details[i].children;
}
i = i + 1;
}

// console.log(checkInDate, checkOutDate, total_adult, total_child, area.id, area.type, area.name);

const searchObj = {
"source_market": "IN",
"type": "hotel",
"id": hotel.id,
"name": hotel.name,
"check_in_date": checkInDate,
"check_out_date": checkOutDate,
"total_adult_count": total_adult.toString(),
"total_child_count": total_child.toString(),
"total_room_count": details.length.toString(),
"details": details
}

if (transaction_identifier && transaction_identifier != "undefined") {
searchObj.transaction_identifier = transaction_identifier;
}

let data;
try {
data = await Api.hotels.post("/search", {
'search': searchObj
});
} catch (err) {
return next(err);
}

console.log(searchObj);

console.log(data.data.hotels[0].rates.packages);

if (!data.data) {
console.log(searchObj);
console.log(data);
return res.status(404).send('Hotel not Found');
}
// If user is directly searching hotel
else if (data.data && data.data.totalPackagesCount < 1) {
console.log(`Error: Searched hotel cannot be found`);
console.log(data);
return res.status(404).send("Hotel cannot be found");
} else {
// console.log(data.data.hotels[0].rates.packages);

// hotel which will be sent to the client
// making deep copy of an object
let selectedHotel = JSON.parse(JSON.stringify(data.data.hotels[0]));

const promiseArray = selectedHotel.rates.packages.map(async (pkg) => {
// console.log(pkg.booking_key);
// console.log(pkg.chargeable_rate);
try {
// addMarkup method will apply markup and other charges on hotelPackage
await addMarkup(pkg);
} catch (err) {
return res.status(500).json({
'message': `${err}`
})
}
return pkg;
});

const hotelPackages = await Promise.all(promiseArray);

// update hotel packages with updated rates
selectedHotel.rates.packages = hotelPackages;
// console.log(selectedHotel.rates.packages[0]);
// console.log(data.data.hotels[0].rates.packages)
// add hotel to the db


// add meta search reference in hotel if hotel request is coming through meta search sites like trivago

let metaSearch;
try {
metaSearch = await MetaSearch.findOne({
'vendor.referenceId': referenceId
})
} catch (err) {
logger.error(err);
}

let metaSearchReferenceId = '';

if (metaSearch) {
metaSearchReferenceId = metaSearch._id
}

try {
await Hotel.findByIdAndUpdate(hotelId, {
'$set': {
'meta_search_referenceId': metaSearchReferenceId,
'rates.packages': data.data.hotels[0].rates.packages
}
}, {
new: true,
upsert: true,
setDefaultsOnInsert: true
});
} catch (err) {
console.log(err);
return res.status(404).json({
'message': 'Hotel not found!!!!'
})
}

const dataObj = {
'data': {
'search': data.data.search,
// 'hotel': data.data.hotels[0],
// 'hotel': hotelObj,
'hotel': selectedHotel,
'currentPackagesCount:': data.data.currentPackagesCount,
'totalPackagesCount:': data.data.totalPackagesCount,
'page': data.data.page,
'perPage': data.data.perPage,
'totalPages': data.data.totalPages,
'status': data.data.status,
'transaction_identifier': data.transaction_identifier
}
}
dataObj.data.hotel.hotelId = hotel._id;
// console.log(dataObj);

res.json(dataObj);
}
};

exports.bookingpolicy = async (req, res, next) => {

const transaction_id = req.body.transaction_id;
const search = req.body.search;
// const package = req.body.package;
const bookingKey = req.body.bookingKey;
const hotelId = req.body.hotelId;

if (!search || !bookingKey || !hotelId) {
return res.status(400).send("Validation failed...");
}

if (!transaction_id) {
logger.error('transaction_identifier is required in bookingPolicy... ');
return res.status(400).send("Validation failed... transaction_id is required..");
}

let data;
let hotel;

try {
hotel = await Hotel.findById(hotelId);
let package = hotel.rates.packages.filter((package) => package.booking_key === bookingKey)[0];

// console.log(transaction_id, search, package);
if (!package) {
logger.error("No package found by this booking_key");
throw new Error("Unable to get the booking policy");
}

data = await Api.hotels.post("/bookingpolicy", {
"bookingpolicy": {
"transaction_identifier": transaction_id,
"search": search,
"package": package,
}
});
} catch (err) {
return res.status(500).json({
'message': err.message
})
}

if (!data || !data.data) {
console.log(data);
return res.status(500).send("Unable to get the booking policy");
}

// bookingPolicy = refrence of data.data
const bookingPolicy = data.data;
const hotelPackage = bookingPolicy.package;

try {
// addMarkup method will apply markup and other charges on hotelPackage
await addMarkup(hotelPackage);
} catch (err) {
return res.status(500).json({
'message': `${err}`
})
}

const booking_policy = await new BookingPolicy({
'booking_policy': bookingPolicy,
'search': search,
'transaction_identifier': transaction_id,
"hotel": hotelId,
});

await booking_policy.save();

res.json(data);
};

exports.prebook = async (req, res, next) => {

// const search = req.body.search;
// const booking_policy = req.body.booking_policy;
// const transaction_id = req.body.transaction_id;
// const contactDetail = req.body.contactDetail;
// const hotel = req.body.hotel;
// const hotelPackage = req.body.package;
// const coupon = req.body.coupon;
// const gstDetail = req.body.gstDetail;

const booking_policy_id = req.body.booking_policy_id;
const transaction_id = req.body.transaction_id;
const contactDetail = req.body.contactDetail;
const coupon = req.body.coupon;
const guests = req.body.guest;
// const gstDetail = req.body.gstDetail;

console.dir(guests);

// sanity checking
// if (!search || !booking_policy || !guest || !transaction_id || !contactDetail || !hotel || !hotelPackage) {
// return res.status(400).json({
// 'message': 'Booking cannot be completed! Please try again.'
// });
// }
if (!booking_policy_id || !transaction_id || !contactDetail) {
return res.status(400).json({
'message': 'Booking cannot be completed! Please try again. booking_policy_id, transaction_id and contactDetail required..'
});
}

contactDetail.mobile = contactDetail.mobile.toString();

let isAuth = false;
let userId;
// check is user is authenticated
const authHeader = req.get('Authorization');
// console.log(authHeader);
if (authHeader) {
// Get token string after Bearer
const token = authHeader.split(' ')[1];
let decodedToken;
try {
decodedToken = jwt.verify(token, jwtSecret);
} catch (err) {
console.log(err);
}
if (decodedToken) {
isAuth = true;
userId = decodedToken.userId;
}
}

// Handle anonemous user
if (!isAuth) {
// check if user with this mobile no. already exists
const user = await User.findOne({
"mobile": contactDetail.mobile
});
// If user does not exists, create new user
if (!user) {
// Generate random string of 8 characters
// adding two Math.random() will generate string with minimum length of 20.
const randomStr = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);

const hashedPwd = await bcrypt.hash(randomStr, 12);

const name = contactDetail.name;
const last_name = contactDetail.last_name;
const mobile = contactDetail.mobile;
const email = contactDetail.email;
const password = hashedPwd;

let newUser = await new User({
name,
last_name,
mobile,
email,
// temporary password for anonymous user
password,
verified: true
});

Sms.send("91" + contactDetail.mobile, `Your TripBazaar account has been created. You can login to your account using your mobile No. and password: ${randomStr}`, (data) => {
if (data.type != "success") {
console.log(`Warning: Hotel prebook - failed to send temporary password to ${contactDetail.name}`);
}
});
await newUser.save();
newUser = newUser.toObject();
delete newUser.password;
userId = newUser._id;
} else {
// @TODO If user exists with provided mobile no
userId = user._id;
}
}

const bookingPolicy = await BookingPolicy.findOne({
'booking_policy.booking_policy_id': booking_policy_id,
'transaction_identifier': transaction_id
}).populate('hotel');

// console.log(bookingPolicy);
// console.log(bookingPolicy.booking_policy.booking_policy_id);

const hotelPackage = bookingPolicy.booking_policy.package;
const hotel = bookingPolicy.hotel;

// let chargeable_rate = +hotelPackage.chargeable_rate;
let baseAmount = +hotelPackage.base_amount;
let serviceCharge = +hotelPackage.service_charge;
let processingFee = +hotelPackage.processing_fee;
let gst = +hotelPackage.gst;

const baseAmountIncDiscount = Math.ceil(baseAmount);
const clientDiscount = Math.ceil(hotelPackage.guest_discount_percentage ? (hotelPackage.guest_discount_percentage / 100) * baseAmount : 0);
const baseAmountExcDiscount = baseAmountIncDiscount - clientDiscount;
const couponDiscount = Math.ceil(coupon.type == 'fixed' ? coupon.value : (coupon.value / 100) * baseAmountIncDiscount);

const totalChargeableAmount = Math.ceil(baseAmountIncDiscount - couponDiscount + serviceCharge + processingFee + gst);

// console.log(totalChargeableAmount, baseAmountIncDiscount, chargeable_rate, baseAmount, serviceCharge, processingFee, gst);

const actual_room_rate = +hotelPackage.room_rate;
const client_commission = +hotelPackage.client_commission;
const base_amount_markup_excluded = Math.ceil(actual_room_rate + client_commission);
const markup_applied = Math.ceil(baseAmount - base_amount_markup_excluded);

const pricing = {
base_amount_discount_included: baseAmountIncDiscount,
base_amount_discount_excluded: baseAmountExcDiscount,
coupon_discount: couponDiscount,
client_discount: clientDiscount,
service_charges: serviceCharge,
processing_fee: processingFee,
gst: gst,
total_chargeable_amount: totalChargeableAmount,
actual_room_rate: actual_room_rate,
client_commission: client_commission,
base_amount_markup_excluded: base_amount_markup_excluded,
markup_applied: markup_applied,
currency: hotelPackage.chargeable_rate_currency
};

const transaction = new Transaction();

transaction.userId = userId;
transaction.search = bookingPolicy.search;
transaction.booking_policy = bookingPolicy.booking_policy;
transaction.transaction_identifier = transaction_id;
transaction.contactDetail = contactDetail;
transaction.hotel = hotel.toObject();
transaction.coupon = coupon;
transaction.hotelPackage = hotelPackage;
transaction.status = 0;
transaction.pricing = pricing;

// const payload = {
// "prebook": {
// "transaction_identifier": transaction_id,
// "booking_policy_id": bookingPolicy.booking_policy.booking_policy_id,
// "guest": {
// "first_name": contactDetail.name,
// "last_name": contactDetail.last_name,
// "contact_no": contactDetail.mobile,
// "email": contactDetail.email,
// "nationality": "IN"
// }
// }
// };

// for now passing same same lead guest for every room
const room_lead_guests = [];
let room_guests = [];

const roomCount = transaction.search.room_count;

for (let i = 0; i < roomCount; i++) {
const leadGuest = {
"first_name": contactDetail.name,
"last_name": contactDetail.last_name,
"nationality": "IN"
}
room_lead_guests.push(leadGuest);
}

console.log(room_lead_guests, roomCount)


if (guests && guests.length > 0) {
room_guests = guests.map((guest) => {
return {
"first_name": guest.room_guest[0].firstname,
"last_name": guest.room_guest[0].lastname,
"contact_no": guest.room_guest[0].mobile,
"nationality": guest.room_guest[0].nationality
}
})
}

console.log(room_guests, roomCount)

const payload = {
"prebook": {
"transaction_identifier": transaction_id,
"booking_policy_id": bookingPolicy.booking_policy.booking_policy_id,
"room_lead_guests": room_lead_guests,
"contact_person": {
"salutation": "Mr.",
"first_name": contactDetail.name,
"last_name": contactDetail.last_name,
"email": contactDetail.email,
"contact_no": contactDetail.mobile
},
"guests": room_guests
}
}

console.log(payload);
try {
const data = await Api.hotels.post("/prebook", payload);

console.log('response', data);
if (data.data && data.data !== undefined) {
try {
transaction.prebook_response = data;
await transaction.save();
data.transactionid = transaction._id;
res.json(data);
} catch (e) {
console.log(e.message);
res.status(500).send("Cannot book selected hotel");
}
} else {
console.log('error data.data not found', data);
console.log('Payload: ', payload);
res.status(500).send("Cannot book selected hotel!");
}
} catch (err) {
next(err);
}
};

exports.transactions = async (req, res, next) => {
const user = req.body.user;
// console.log(user._id, req.user._id)
if (user._id !== req.user._id) {
return res.status(403).json({
"message": "Not Authorized"
});
}

const data = await Transaction.find({
$and: [{
"userId": {
$exists: true
}
},
{
"userId": req.user._id
}
]
})
.sort("-created_at")

// console.log(data);

const response = [];

data.forEach((res) => {
const hotel = res.hotel;
delete hotel.rates;

const prebook_response = {
data: {
package: {
adult_count: res.prebook_response.data.package.adult_count,
check_in_date: res.prebook_response.data.package.check_in_date,
check_out_date: res.prebook_response.data.package.check_out_date,
child_count: res.prebook_response.data.package.child_count,
room_count: res.prebook_response.data.package.room_count,
room_details: res.prebook_response.data.package.room_details,
rate_type: res.prebook_response.data.package.rate_type,
}
}
}

const cancel_response = {};

if (res.cancel_response && res.cancel_response.data) {
cancel_response.data = {
'cancellation_details': res.cancel_response.data.cancellation_details,
'cancellation_policy': res.cancel_response.data.cancellation_policy,
}
}

const book_response = {};

if (res.book_response && res.book_response.data) {
book_response.data = res.book_response.data;
}

const newData = {
'bookingId': res._id,
'search': res.search,
'hotel': hotel,
'cancellation_policy': res.booking_policy.cancellation_policy,
'contact_details': res.contactDetail,
'coupon': res.coupon,
'hotel_package': res.hotelPackage,
'status': res.status,
'pricing': res.pricing,
'prebook_response': prebook_response,
'payment_response': res.payment_response || {},
'book_response': book_response,
'cancel_response': cancel_response,
'created_at': res.created_at
}

response.push(newData);
});

res.json({
"status": 200,
"data": response
});
}

exports.bookingStatus = async (_req, res, next) => {

// let term = ;

// let data = await Api.get("/bookstatus", {
// "bookstatus": {
// "booking_id": ""
// }
// });

// res.json(data);
res.send("feature comming soon");
};

exports.cancelBooking = async (req, res, next) => {

const user = req.body.user;
const transactionId = req.body.transactionId;
// console.log(transactionId, user._id);

if (user._id !== req.user._id) {
return res.status(403).json({
"message": "Not Authorized"
});
}
const transaction = await Transaction.findOne({
"_id": transactionId,
"userId": req.user._id
});

if (!transaction) {
return res.status(404).json({
message: "Invalid transaction id, please try again"
});
}

let data;

try {
data = await Api.hotels.post("/cancel", {
"cancel": {
"booking_id": transaction.prebook_response.data.booking_id
}
});
} catch (err) {
console.log('Booking cannot be cancelled, please try again.', err);
return res.status(500).json({
status: "500",
message: 'Booking cannot be cancelled, please try again.'
});
}

if (!data || !data.data) {
console.log(data);
return res.status(500).json({
"message": "Booking cannot be cancelled"
});
}


// console.log(transaction.payment_response);

// modified cancel response: updated charges, markup

// cancellation charge will be provided in the b2cAdmin
let config;
try {
config = await Config.findOne({});

if (!config.cancellation_charge || !config.cancellation_charge.value < 0) {
throw new Error('');
}

} catch (err) {
logger.error('Unable to cancel the hotel booking, cannot get cancellation charges from config collection at cancel hotel booking..', err);
return res.status(500).json({
'message': 'Unable to cancel the hotel booking.'
})
}

const cancelResponse = data;

const baseAmount = +transaction.pricing.base_amount_discount_included;

let cancellationCharge = 0;
if (config.cancellation_charge.type === 'percentage') {
cancellationCharge = (config.cancellation_charge.value / 100) * baseAmount;
} else if (config.cancellation_charge.type === 'fixed') {
cancellationCharge = config.cancellation_charge.value;
}

const penaltyPercentage = +cancelResponse.data.cancellation_details.api_penalty_percentage;

const penaltyValue = (penaltyPercentage / 100) * baseAmount + cancellationCharge;

const penalty = {
'value': penaltyValue,
'currency': cancelResponse.data.cancellation_details.api_penalty.currency
}

// refund value is zero when penalty is greater than base amount
const refundValue = (baseAmount - penaltyValue) <= 0 ? 0 : baseAmount - penaltyValue;

const refund = {
'value': refundValue,
'currency': cancelResponse.data.cancellation_details.api_penalty.currency
}

cancelResponse.data.cancellation_details.penalty = penalty;
cancelResponse.data.cancellation_details.cancellation_charge = cancellationCharge;
cancelResponse.data.cancellation_details.refund = refund;
cancelResponse.data.cancellation_details.penalty_percentage = penaltyPercentage;

transaction.cancel_response = cancelResponse;
transaction.status = 2; // booking cancelled

await transaction.save();

console.log(cancelResponse);

delete cancelResponse.data.cancellation_details.api_penalty;
delete cancelResponse.data.cancellation_details.api_penalty_percentage;

res.json(cancelResponse);

Sms.send("91" + transaction.contactDetail.mobile, `Your hotel ${transaction.hotel.originalName} has been cancelled. Your refund will be processed according to the the cancellation policy.`, (data) => {
if (data.type != "success") {
console.log(`Warning: Hotel cancel - failed to send canellation message to ${transaction.contactDetail.name}`);
}
});

Sms.send("917678105666", `Hello admin, hotel ${transaction.hotel.originalName} has been cancelled. Guest name : ${transaction.contactDetail.name}, Contact no: ${transaction.contactDetail.mobile}.`, (data) => {
if (data.type != "success") {
console.log(`Warning: Hotel cancel - failed to send canellation message to the admin`);
}
});

};

exports.invoice = async (req, res, next) => {
const transactionid = req.query.transactionid;
const transaction = await Transaction.findById(transactionid);

if (!transaction) {
return res.status(500).send('Invalid booking id');
}

if (transaction.userId != req.user._id) {
return res.status(403).send('Not Authorized!');
}
console.log(transaction)
if (transaction.status != 1) {
return res.status(422).send('Cannot get invoice for incomplete transaction');
}

let buffer;
try {
buffer = await generateInvoice(transaction);
} catch (err) {
console.log('Cannot get invoice for the given transaction');
console.log(err);
return res.status(422).json({
'message': 'Cannot get invoice for the given transaction'
});
}

res.header('Content-type', 'application/pdf');
res.send(buffer);
}

exports.voucher = async (req, res, _next) => {
const transactionid = req.query.transactionid;
console.log(transactionid);
if (!transactionid) {
return res.status(422).json({
'message': 'Cannot get voucher for the given transaction'
});
}

const transaction = await Transaction.findById(transactionid);

if (!transaction) {
return res.status(500).send('Invalid booking id');
}
if (transaction.userId != req.user._id) {
return res.status(403).send('Not Authorized!');
}

if (transaction.status != 1) {
return res.status(422).send('Cannot get voucher for incomplete transaction');
}
let buffer;
try {
buffer = await generateVoucher(transaction);
} catch (err) {
console.log('Cannot get voucher for the given transaction');
console.log(err);

return res.status(422).json({
'message': 'Cannot get voucher for the given transaction'
});
}

res.header('Content-type', 'application/pdf');
res.send(buffer);
}