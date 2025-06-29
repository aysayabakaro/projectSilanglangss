const express = require("express");
const  cors = require("cors");
const  bodyParser = require("body-parser");
const  mongoose = require("mongoose");
const  admin = require("firebase-admin");
const  dotenv = require("dotenv");
const  { SensorData } = require("./models/sensorDataModel.js");
const  { Place } = require("./models/placeModel.js");
const  sessionFileStore = require("session-file-store");
const  session = require("express-session");
const  axios = require("axios"); // For sending SMS
const  ntpClient = require("ntp-client");

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Manila");

// pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

const  path = require("path");
const  fs = require("fs");
const  { User } = require("./models/userModel.js");
const  pdf = require("./pdf.js");

require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const SEMAPHORE_API_KEY = process.env.SEMAPHORE_API_KEY; // API Key from .env
const recipients = ["092623374881","091716956811","091716956811","099546713801"]; // List of phone numbers["09262337488","09171695681","09171695681","09954671380"];
const FileStore = sessionFileStore(session);


console.clear();

const green = "\x1b[32m";
const reset = "\x1b[0m";

const logo = `${green}                                
             .:=+++-.             
           .=%@%%%%%**-           
          :%@%#*==-==+#*.         
         -%*==-::::::-=**.        
        .##==---:::::--=#+        
        .#*++**+=--=+++=+*        
       .-#++*##+===+##*=++.       
       .-*+----:::::----+=.       
        .-+-:::-==--:::--:        
       .:%%++++=====+++*+=        
      .-#%@%*+=======+#@%+:::.    
     .:+%@@@@**+++++*%@@@%#%#-.   
    ...+%@@@#********#%@@@@%#+:.  
  ..+#%%%%**++****+====%%%%%%%%%#*
:*%%%%%%%%+==---------*%###%%%#%%#
%%%%#%%%%%#=-----:::-+##*--:+%%##+
#%%%#%%%%%%%=-------*##%#-:-*#%%*-
#%%%%%%%%%%%%*=-==+*#%%%%%##%%%**%
-#%%%%%%%##*+*##%@@@#+*#%%%%%#+#%%
%%#%%@%###%@@%*==*%@@@@@#*++*%@%%%
%@@@@@@@@@%%+-=+=++%%%%%@@%%@@@%%%
${reset}`;

console.log(logo);


// Ensure Firebase service account JSON exists
const serviceAccountPath = path.resolve("silang-df204-firebase-adminsdk-fbsvc-5b12f3198e.json");
if (!fs.existsSync(serviceAccountPath)) {
  console.error("🔥 Firebase service account JSON not found!");
  process.exit(1);
}

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccountPath),
});
const db = admin.firestore();
console.log("✅ Firebase initialized successfully!");

const connectToDB = async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB Atlas!");

    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB Connection Error:", err);
    });
  } catch (err) {
    console.error("❌ Error connecting to MongoDB:", err);
    process.exit(1);
  }
};
connectToDB();


const corsConfig = {
  credentials: true,
  origin: true,
};
// Middleware
app.set('trust proxy', 1)
app.use(cors());
app.use(bodyParser.json());

const sendSMS = async (message) => {
  try {
    const requests = recipients.map((number) =>
      axios.post("https://api.semaphore.co/api/v4/messages", {
        apikey: SEMAPHORE_API_KEY,
        number: number,
        message: message,
        sendername: "CLOUDLINK",
      })
    );

    const responses = await Promise.all(requests);
    responses.forEach((res, index) =>
      console.log(`SMS sent to ${recipients[index]}:`, res.data)
    );
  } catch (error) {
    console.error("Error sending SMS:", error.response?.data || error.message);
  }
};

// ✅ Rainfall alert handler
const sendRainfallWarning = async (hourlyRainfall, locationId) => {
  if (hourlyRainfall >= 60 && hourlyRainfall <= 63) {
    await sendSMS(`Red Orange rainfall warning at ${locationId} - Hourly Rainfall: ${hourlyRainfall}mm`);
  } else if (hourlyRainfall >= 30 && hourlyRainfall <= 33) {
    await sendSMS(`Orange rainfall warning at ${locationId} - Hourly Rainfall: ${hourlyRainfall}mm`);
  } else if (hourlyRainfall >= 14 && hourlyRainfall <= 17) {
    await sendSMS(`Yellow rainfall warning at ${locationId} - Hourly Rainfall: ${hourlyRainfall}mm`);
  }
};

const sensorDataCollection = db.collection("sensor_data");

sensorDataCollection.onSnapshot(async (snapshot) => {
  const addedDocs = snapshot
    .docChanges()
    .filter(change => change.type === "added")
    .map(change => ({
      doc: change.doc,
      data: change.doc.data(),
      ref: change.doc.ref,
      id: change.doc.id
    }));

  // Sort from oldest to newest
  addedDocs.sort((a, b) => {
    const aDate = a.data.date_time?.toDate?.() ?? new Date(a.data.date_time);
    const bDate = b.data.date_time?.toDate?.() ?? new Date(b.data.date_time);
    return aDate - bDate;
  });

  for (const { doc, data, ref: docRef, id: docId } of addedDocs) {
    try {
      const {
        rainfall, voltage, current, power,
        rainfallhourly, comms_status, internet_status,
        rssi, location_ID, errors, date_time
      } = data;

      if (!location_ID) {
        console.log(`⏭️ Skipping doc ${docId} — missing locationId`);
        continue;
      }

      let parsedDate;
      if (date_time instanceof Date) {
        parsedDate = date_time;
      } else if (typeof date_time?.toDate === "function") {
        parsedDate = date_time.toDate();
      } else {
        parsedDate = new Date(date_time);
      }

      if (isNaN(parsedDate.getTime())) {
        console.warn(`⏭️ Skipping doc ${docId} — invalid date_time:`, date_time);
        continue;
      }

      const now = new Date();
      if (parsedDate > now) {
        console.log(`⏭️ Skipping doc ${docId} — future timestamp: ${parsedDate.toISOString()}`);
        continue;
      }

      const exists = await SensorData.findOne({ firestoreId: docId });
      if (exists) {
        console.log(`⏭️ Firestore doc ${docId} already saved. Skipping.`);
        continue;
      }

      const sensorReading = new SensorData({
        firestoreId: docId,
        createdAt: parsedDate,
        rainfall: parseFloat(rainfall),
        hourlyRainfall: parseFloat(rainfallhourly),
        voltage: parseFloat(voltage),
        current: parseFloat(current),
        power: parseFloat(power),
        commStatus: Boolean(comms_status),
        internetStatus: Boolean(internet_status),
        rssi: parseInt(rssi),
        errors,
        locationId: location_ID,
      });

      await sensorReading.save();

      if (sensorReading.rainfall > 0.5) {
        console.log("🌧️ Rainfall > 0.5mm detected:", sensorReading.rainfall);
      }

      await sendRainfallWarning(sensorReading.hourlyRainfall, sensorReading.locationId);

      await docRef.delete();

      const green = "\x1b[32m", reset = "\x1b[0m";
      const localDateTime = parsedDate.toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
      console.log(`🗑️ ${docId} | ${sensorReading.locationId} | UTC: ${parsedDate.toISOString()} | PH: ${parsedDate.toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`);
    } catch (error) {
      console.error(`❌ Error processing doc ${docId}:`, error.message);
    }
  }
});





app.get("/time", (req, res) => { 
  const systemTime = new Date().toISOString();
  res.json({ ntpTime: systemTime });
});


app.use(
  session({
    store: new FileStore(),
    secret: "silangSession",
    resave: false,
    cookie: {
      maxAge: 60 * 60 * 1000,
      secure: true,
    },
    rolling: true,
    saveUninitialized: false,
  })
);

app.delete("/sensor-data-cleanup", async (req, res) => {
  try {
    const { locationId, date, start, end } = req.query;

    if (!locationId) {
      return res.status(400).json({ message: "❌ 'locationId' is required" });
    }

    const query = { locationId };

    const offsetMillis = 8 * 60 * 60 * 1000; // UTC+8

    if (date) {
      const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
      if (!isValidDate) {
        return res.status(400).json({ message: "❌ Invalid date format. Use YYYY-MM-DD" });
      }

      if (start && end) {
        const isValidTime = /^([01]\d|2[0-3]):([0-5]\d)$/.test(start) && /^([01]\d|2[0-3]):([0-5]\d)$/.test(end);
        if (!isValidTime) {
          return res.status(400).json({ message: "❌ Invalid time format. Use HH:mm" });
        }
        const startTime = new Date(new Date(`${date}T${start}:00`).getTime() - offsetMillis);
        const endTime = new Date(new Date(`${date}T${end}:00`).getTime() - offsetMillis);
        query.createdAt = { $gte: startTime, $lt: endTime };
      } else {
        // If only date is provided, delete full day
        const startTime = new Date(new Date(`${date}T00:00:00`).getTime() - offsetMillis);
        const endTime = new Date(new Date(`${date}T23:59:59`).getTime() - offsetMillis);
        query.createdAt = { $gte: startTime, $lt: endTime };
      }
    }

    console.log("Deleting with filter:", JSON.stringify(query));

    const result = await SensorData.deleteMany(query);

    res.json({
      message: `🗑️ Deleted ${result.deletedCount} documents`,
      filter: query,
    });
  } catch (error) {
    console.error("❌ Error during deletion:", error.message);
    res.status(500).json({
      message: "❌ Failed to delete sensor data",
      error: error.message,
    });
  }
});



app.post("/session", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) return res.status(400).json({message: "Username and Password are required"});

  const user = await User.findOne({username, password}).lean();
  if (!user)  return res.status(400).json({message: "Invalid Username & Password combination"});

  return res.json({message: "Successfully logged in.", placeAccesses: user.placeAccesses})
});

app.get("/session", async (req, res) => {
  return res.json({
    placeAccesses: req.session.userSession.placeAccesses,
  })
})

app.delete("/session", async (req, res) => {
  return req.session.destroy(() => {
    res.status(200).json({ _message: "Logout Successfully" });
  });
})


// Health check endpoint
app.get("/", (req, res) => res.send("🔥 Server is running!"));

// Fetch latest sensor data from MongoDB

// ✅ Retrieve Data
app.get("/places", async (req, res) => {
  try {

    const data = await Place.find().lean();
    return res.json(data);
  } catch (err) {
    console.error("❌ Error fetching data:", err);
    res
      .status(500)
      .json({ message: "❌ Error fetching data!", error: err.message });
  }
});

app.get("/sensor-data/:locationId", async (req, res) => {
  const { locationId } = req.params;
  const { from, to } = req.query;

  const sensorData = await SensorData.find({
    locationId,
    createdAt: { $gte: new Date(from), $lte: new Date(to) },
  })
    .sort({ createdAt: 1 })

  return res.json(sensorData);
});

app.get("/sensor-data-latest/:locationId", async (req, res) => {
  const { locationId } = req.params;
  const sensorData = await SensorData.find({ locationId })
    .sort({ createdAt: -1 })
    .limit(1);
  return res.json(sensorData[0] || null);
});

const dayjs = require("dayjs");
const timezone = require("dayjs/plugin/timezone");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);
dayjs.extend(timezone);

app.get("/sensor-data-report/:locationId", async (req, res) => {
  const { locationId } = req.params;
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({ message: "Missing 'from' or 'to' query parameters." });
  }

  try {
    const fromDate = dayjs(from).tz().startOf("day").toDate();
    const toDate = dayjs(to).tz().endOf("day").toDate();

    const reportData = await SensorData.aggregate([
      {
        $match: {
          locationId,
          createdAt: { $gte: fromDate, $lte: toDate }
        }
      },
      {
        $project: {
          adjustedCreatedAt: {
            $dateAdd: {
              startDate: "$createdAt",
              unit: "hour",
              amount: 8
            }
          },
          locationId: 1,
          rainfall: 1
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$adjustedCreatedAt" },
            month: { $month: "$adjustedCreatedAt" },
            day: { $dayOfMonth: "$adjustedCreatedAt" },
            hour: { $hour: "$adjustedCreatedAt" }
          },
          totalRainfall: { $sum: "$rainfall" }
        }
      },
      {
        $sort: {
          "_id.year": 1,
          "_id.month": 1,
          "_id.day": 1,
          "_id.hour": 1
        }
      }
    ]);

    const fromString = dayjs(from).tz().format("MMMM D, YYYY");
    const toString = dayjs(to).tz().format("MMMM D, YYYY");
    const timestamp = dayjs().tz().format("MM/DD/YY hh:mm a");

    const rainfallMap = new Map();

    for (const item of reportData) {
      const key = dayjs()
        .set("year", item._id.year)
        .set("month", item._id.month - 1)
        .set("date", item._id.day)
        .set("hour", item._id.hour)
        .set("minute", 0)
        .format("MM/DD/YY hh:mm a");

      rainfallMap.set(key, item.totalRainfall || 0);
    }

    const data = [];
    let current = dayjs(from).tz().startOf("hour");
    const end = dayjs(to).tz().endOf("hour");

    while (current.isBefore(end) || current.isSame(end)) {
      const label = current.format("MM/DD/YY hh:mm a");
      const rainfall = parseFloat((rainfallMap.get(label) || 0).toFixed(2));
      data.push({ label, value: rainfall });
      current = current.add(1, "hour");
    }

    // Generate the PDF stream
    const pdfStream = await pdf.pdf({ timestamp, from: fromString, to: toString, data });

    // Convert stream to buffer helper
    const streamToBuffer = (stream) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks)));
      });

    const pdfBuffer = await streamToBuffer(pdfStream);

    // Format filename
    const fromFormatted = dayjs(from).tz().format("MM-DD-YY");
    const toFormatted = dayjs(to).tz().format("MM-DD-YY");

    // Remove special characters like parentheses and spaces
    const rawFilename = `Report_${fromFormatted}_${toFormatted}.pdf`;
    const encodedFilename = encodeURIComponent(rawFilename);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${rawFilename}"; filename*=UTF-8''${encodedFilename}`
    );

    return res.send(pdfBuffer);
  } catch (error) {
    console.error("Error generating report:", error);
    return res.status(500).json({
      message: "❌ Failed to generate report",
      error: error.message
    });
  }
});


app.delete('/sensor-data/delete', async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "Invalid or empty IDs array." });
  }

  try {
    const result = await SensorData.deleteMany({ _id: { $in: ids } });
    res.status(200).json({ deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.get("/per-min-sensor-data/:locationId", async (req, res) => {
  const { locationId } = req.params;

  try {
    const now = dayjs().tz("Asia/Manila");
    const twentyFourHoursAgo = now.subtract(24, 'hours').toDate();

    console.log("Getting non-zero rainfall for", locationId);
    console.log("From:", twentyFourHoursAgo);
    console.log("To:", now.toDate());

    const realTimeData = await SensorData.aggregate([
      {
        $match: {
          locationId: locationId,
          createdAt: { $gte: twentyFourHoursAgo, $lte: now.toDate() },
          rainfall: { $gt: 0 } // ✅ non-zero only
        }
      },
      {
        $setWindowFields: {
          partitionBy: "$locationId",
          sortBy: { createdAt: 1 },
          output: {
            rainfallhourly: {
              $sum: "$rainfall",
              window: {
                range: [-60 * 60 * 1000, 0], // past 1 hour in ms
                unit: "millisecond"
              }
            }
          }
        }
      },
      {
        $project: {
          _id: 1,
          createdAt: 1,
          rainfall: 1,
          rainfallhourly: 1,
          voltage: 1,
          current: 1,
          power: 1,
          internetStatus: 1,
          pumpStatus: 1,
          rssi: 1,
          locationId: 1,
          adjustedCreatedAt: {
            $dateAdd: {
              startDate: "$createdAt",
              unit: "hour",
              amount: 8 // UTC to Asia/Manila
            }
          }
        }
      },
      {
        $sort: { adjustedCreatedAt: 1 }
      }
    ]);

    const data = realTimeData.map(item => ({
      label: dayjs(item.adjustedCreatedAt).format("MM/DD/YY hh:mm A"),
      ...item
    }));

    console.log("Records found:", data.length);

    res.status(200).json({ data });
  } catch (error) {
    console.error("Error fetching sensor data:", error.message);
    res.status(500).json({ message: "Failed to fetch sensor data", error: error.message });
  }
});


//realtime data

app.get("/real-time-sensor-data/:locationId", async (req, res) => {
  const { locationId } = req.params;

  try {
    const now = dayjs().tz("Asia/Manila");
    const twentyFourHoursAgo = now.subtract(24, 'hours').toDate();

    const realTimeData = await SensorData.aggregate([
      {
        $match: {
          locationId: locationId,
          createdAt: { $gte: twentyFourHoursAgo, $lte: now.toDate() }
        }
      },
      {
        $project: {
          adjustedCreatedAt: {
            $dateAdd: {
              startDate: "$createdAt",
              unit: "hour",
              amount: 8 // Adjust to Asia/Manila timezone
            }
          },
          rainfall: 1,
        }
      },
      {
        $addFields: {
          year: { $year: "$adjustedCreatedAt" },
          month: { $month: "$adjustedCreatedAt" },
          day: { $dayOfMonth: "$adjustedCreatedAt" },
          hour: { $hour: "$adjustedCreatedAt" },
        }
      },
      {
        $group: {
          _id: {
            year: "$year",
            month: "$month",
            day: "$day",
            hour: "$hour"
          },
          totalRainfall: { $sum: "$rainfall" }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1, "_id.hour": 1 } }
    ]);

    const data = realTimeData.map(item => {
      const date = dayjs()
        .set("year", item._id.year)
        .set("month", item._id.month - 1)  // months are 0-indexed
        .set("date", item._id.day)
        .set("hour", item._id.hour)
        .set("minute", 0)
        .set("second", 0);

      return {
        label: date.format("MM/DD/YY hh:mm A"),
        value: item.totalRainfall
      };
    });

    res.status(200).json({ data });
  } catch (error) {
    console.error("Error fetching real-time data:", error.message);
    res.status(500).json({ message: "Failed to fetch real-time data", error: error.message });
  }
});



// monthly sensor data
app.get("/monthly-sensor-data/:locationId", async (req, res) => {
  const { locationId } = req.params;

  try {
    const now = dayjs().tz("Asia/Manila");
    const thirtyDaysAgo = now.subtract(30, 'days').toDate();

    const monthlyData = await SensorData.aggregate([
      {
        $match: {
          locationId: locationId,
          createdAt: { $gte: thirtyDaysAgo, $lte: now.toDate() },
        },
      },
      {
        $project: {
          adjustedCreatedAt: {
            $dateAdd: {
              startDate: "$createdAt",
              unit: "hour",
              amount: 8, // Adjust to timezone (Asia/Manila)
            },
          },
          rainfall: 1,
        },
      },
      {
        $addFields: {
          year: { $year: "$adjustedCreatedAt" },
          month: { $month: "$adjustedCreatedAt" },
          day: { $dayOfMonth: "$adjustedCreatedAt" },
          sixHourBlock: { $floor: { $divide: [{ $hour: "$adjustedCreatedAt" }, 6] } },
        },
      },
      {
        $group: {
          _id: {
            year: "$year",
            month: "$month",
            day: "$day",
            sixHourBlock: "$sixHourBlock"
          },
          totalRainfall: { $sum: "$rainfall" }
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1, "_id.sixHourBlock": 1 } }
    ]);

    const data = monthlyData.map((item) => {
      const startHour = item._id.sixHourBlock * 6;
      const startDate = dayjs()
        .set("year", item._id.year)
        .set("month", item._id.month - 1) // dayjs months are 0-indexed
        .set("date", item._id.day)
        .set("hour", startHour)
        .set("minute", 0)
        .set("second", 0);

      const label = startDate.format("MM/DD/YY hh:mm A");

      return {
        label,
        value: item.totalRainfall,
      };
    });

    res.status(200).json({ data });
  } catch (error) {
    console.error("Error fetching monthly data:", error.message);
    res.status(500).json({ message: "Failed to fetch monthly data", error: error.message });
  }
});



//yearly data

app.get("/yearly-sensor-data/:locationId", async (req, res) => {
  const { locationId } = req.params;

  try {
    const now = dayjs().tz("Asia/Manila");
    const oneYearAgo = now.subtract(1, 'year').startOf('day').toDate();

    const yearlyData = await SensorData.aggregate([
      {
        $match: {
          locationId: locationId,
          createdAt: { $gte: oneYearAgo, $lte: now.toDate() },
        },
      },
      {
        $project: {
          adjustedCreatedAt: {
            $dateAdd: {
              startDate: "$createdAt",
              unit: "hour",
              amount: 8 // Adjust to your timezone
            },
          },
          rainfall: 1,
        },
      },
      {
        $project: {
          week: { $isoWeek: "$adjustedCreatedAt" },
          year: { $isoWeekYear: "$adjustedCreatedAt" },
          rainfall: 1
        },
      },
      {
        $group: {
          _id: { year: "$year", week: "$week" },
          totalRainfall: { $sum: "$rainfall" }
        },
      },
      { $sort: { "_id.year": 1, "_id.week": 1 } }
    ]);

    // Prepare full weekly range
    const currentYear = now.year();
    const allWeeks = Array.from({ length: 52 }, (_, i) => i + 1);

    const dataMap = {};
    let lastKnownData = null;

    yearlyData.forEach((item) => {
      dataMap[item._id.week] = item.totalRainfall;
      lastKnownData = item.totalRainfall;
    });

    const data = allWeeks.map((week) => {
      const weekStartDate = dayjs().startOf('year').add((week - 1) * 7, 'days');

      const value = dataMap[week] !== undefined
        ? dataMap[week]
        : lastKnownData !== null ? lastKnownData : null;

      if (weekStartDate.isAfter(now)) {
        return { label: `Week ${week}, ${currentYear}`, value: null };
      }

      return {
        label: `Week ${week}, ${currentYear}`,
        value
      };
    });

    res.status(200).json({ data });

  } catch (error) {
    console.error("Error fetching yearly data:", error.message);
    res.status(500).json({ message: "Failed to fetch yearly data", error: error.message });
  }
});


// hourly on different date
app.get("/hourly-sum-required/:locationId", async (req, res) => {
  const { locationId } = req.params;
  const { timestamp } = req.query;

  if (!timestamp) {
    return res.status(400).json({ message: "Missing required query parameter: timestamp" });
  }

  try {
    const target = dayjs(timestamp).tz(); // Adjust to your timezone if needed
    const startOfHour = target.startOf('hour').toDate();
    const endOfHour = target.endOf('hour').toDate();

    const result = await SensorData.aggregate([
      {
        $match: {
          locationId: locationId,
          createdAt: { $gte: startOfHour, $lte: endOfHour },
        },
      },
      {
        $group: {
          _id: null,
          totalRainfall: { $sum: "$rainfall" },
        },
      },
    ]);

    const total = result.length > 0 ? result[0].totalRainfall : 0;

    res.status(200).json({
      hour: `${target.format("YYYY-MM-DD HH:00")}`,
      totalRainfall: total,
    });
  } catch (error) {
    console.error("Error fetching specified hour sum:", error.message);
    res.status(500).json({ message: "Failed to fetch data", error: error.message });
  }
});

// hourly real time
app.get("/current-hour-sum/:locationId", async (req, res) => {
  const { locationId } = req.params;

  try {
    const now = dayjs().tz();
    const startOfHour = now.startOf('hour').toDate();
    const endOfHour = now.toDate();

    const result = await SensorData.aggregate([
      {
        $match: {
          locationId: locationId,
          createdAt: { $gte: startOfHour, $lte: endOfHour },
        },
      },
      {
        $group: {
          _id: null,
          totalRainfall: { $sum: "$rainfall" },
        },
      },
    ]);

    const total = result.length > 0 ? result[0].totalRainfall : 0;

    res.status(200).json({
      hour: `${now.format("YYYY-MM-DD HH:00")}`,
      totalRainfall: total,
    });
  } catch (error) {
    console.error("Error fetching current hour sum:", error.message);
    res.status(500).json({ message: "Failed to fetch data", error: error.message });
  }
});


app.delete("/sensor-data-by-date", async (req, res) => {
  try {
    const { date } = req.body;

    // Parse the date to a valid Date object
    const targetDate = new Date(date);
    const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0)); // Start of the day
    const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999)); // End of the day

    // Perform the deletion query
    const result = await SensorData.deleteMany({
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    });

    res.json({
      message: `🗑️ Deleted ${result.deletedCount} records on ${date}`,
    });
  } catch (error) {
    console.error("❌ Error during deletion:", error.message);
    res.status(500).json({
      message: "❌ Failed to delete records",
      error: error.message,
    });
  }
});

app.get("/sensor-data-count/:locationId", async (req, res) => {
    const { locationId } = req.params;
    const sensorData = await SensorData.countDocuments({
      locationId,
    })
    return res.json(sensorData);
});

app.post("/manual-add-rainfall", async (req, res) => {
  const { locationId, timestamp } = req.body;

  if (!locationId || !timestamp) {
    return res.status(400).json({ message: "❌ 'locationId' and 'timestamp' are required." });
  }

  try {
    const createdAt = new Date(timestamp);

    if (isNaN(createdAt.getTime())) {
      return res.status(400).json({ message: "❌ Invalid timestamp format." });
    }

    // Insert new record
    const result = await SensorData.create({
      locationId,
      rainfall: 0.5,
      createdAt
    });

    res.status(200).json({
      message: "✅ Successfully added 0.5mm rainfall entry.",
      data: result
    });
  } catch (error) {
    console.error("❌ Error inserting rainfall data:", error.message);
    res.status(500).json({
      message: "❌ Failed to insert rainfall data.",
      error: error.message
    });
  }
});

app.delete("/manual-delete-rainfall", async (req, res) => {
  const { locationId, timestamp } = req.body;

  if (!locationId || !timestamp) {
    return res.status(400).json({ message: "❌ 'locationId' and 'timestamp' are required." });
  }

  try {
    const createdAt = new Date(timestamp);
    if (isNaN(createdAt.getTime())) {
      return res.status(400).json({ message: "❌ Invalid timestamp format." });
    }

    const result = await SensorData.deleteMany({ locationId, createdAt });

    res.status(200).json({
      message: `🗑️ Deleted ${result.deletedCount} documents for ${locationId} at ${timestamp}`,
    });
  } catch (error) {
    console.error("❌ Error deleting record:", error.message);
    res.status(500).json({
      message: "❌ Failed to delete rainfall entry.",
      error: error.message,
    });
  }
});




//testing area


/*
(async () => {
  await sendRainfallWarning(8, "PumpingStation A");
  await sendRainfallWarning(15, "PumpingStation B");
  await sendRainfallWarning(30, "PumpingStation C");
})();

*/






// Graceful shutdown for MongoDB connection
process.on("SIGINT", async () => {
  console.log("\n🛑 Closing MongoDB connection...");
  await mongoose.connection.close();
  console.log("✅ MongoDB connection closed.");
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
