require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI);
let db;
async function getDb() {
  if (!db) {
    await client.connect();
    db = client.db("booknook");
  }
  return db;
}

app.get("/", (req, res) => res.send("BookNook server running"));

// পরের ধাপে এখানে API route বসবে

module.exports = app;
if (require.main === module) {
  app.listen(process.env.PORT || 5000, () => console.log("Server on 5000"));
}