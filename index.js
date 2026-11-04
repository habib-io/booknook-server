require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

// ===== SECTION 1: DB connection =====
const client = new MongoClient(process.env.MONGODB_URI);
let database;
async function getDb() {
  if (!database) {
    await client.connect();
    database = client.db("booknook");
  }
  return database;
}

app.get("/", (req, res) => res.send("BookNook server running"));

// ===== SECTION 2: JWT verify =====
let jwks;
async function verifyToken(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).send({ message: "Unauthorized" });
    const { createRemoteJWKSet, jwtVerify } = await import("jose");
    if (!jwks) {
      jwks = createRemoteJWKSet(
        new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
      );
    }
    const { payload } = await jwtVerify(token, jwks);
    req.user = {
      id: payload.sub || payload.id,
      email: payload.email,
      name: payload.name,
    };
    next();
  } catch (error) {
    res.status(401).send({ message: "Invalid or expired token" });
  }
}

// ===== SECTION 3: GET /books, GET /books/:id =====
app.get("/books", async (req, res) => {
  try {
    const db = await getDb();
    const query = {};
    if (req.query.email) query.userEmail = req.query.email;
    let cursor = db.collection("books").find(query).sort({ createdAt: -1 });
    const limit = parseInt(req.query.limit);
    if (limit > 0) cursor = cursor.limit(limit);
    res.send(await cursor.toArray());
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/books/:id", verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ message: "Invalid book id" });
    }
    const db = await getDb();
    const book = await db
      .collection("books")
      .findOne({ _id: new ObjectId(req.params.id) });
    if (!book) return res.status(404).send({ message: "Book not found" });
    res.send(book);
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});

// ===== SECTION 4: POST /books =====
app.post("/books", verifyToken, async (req, res) => {
  try {
    const { title, author, category, image, description, totalCopies } =
      req.body;
    const total = Number(totalCopies);
    if (!title || !author || !category || !image || !description || !(total >= 1)) {
      return res.status(400).send({ message: "All fields are required" });
    }
    const db = await getDb();
    const book = {
      title,
      author,
      category,
      image,
      description,
      totalCopies: total,
      copies: total,
      userName: req.user.name,
      userEmail: req.user.email,
      createdAt: new Date(),
    };
    const result = await db.collection("books").insertOne(book);
    res.send({ ...book, _id: result.insertedId });
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});

// ===== SECTION 5: PATCH + DELETE /books/:id =====
app.patch("/books/:id", verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ message: "Invalid book id" });
    }
    const db = await getDb();
    const books = db.collection("books");
    const _id = new ObjectId(req.params.id);
    const book = await books.findOne({ _id });
    if (!book) return res.status(404).send({ message: "Book not found" });
    if (book.userEmail !== req.user.email) {
      return res.status(403).send({ message: "Forbidden" });
    }
    const update = {};
    for (const f of ["title", "author", "category", "image", "description"]) {
      if (req.body[f]) update[f] = req.body[f];
    }
    const t = Number(req.body.totalCopies);
    if (t >= 1) {
      update.totalCopies = t;
      update.copies = Math.max(0, book.copies + (t - book.totalCopies));
    }
    await books.updateOne({ _id }, { $set: update });
    res.send({ success: true });
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});

app.delete("/books/:id", verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ message: "Invalid book id" });
    }
    const db = await getDb();
    const books = db.collection("books");
    const _id = new ObjectId(req.params.id);
    const book = await books.findOne({ _id });
    if (!book) return res.status(404).send({ message: "Book not found" });
    if (book.userEmail !== req.user.email) {
      return res.status(403).send({ message: "Forbidden" });
    }
    await books.deleteOne({ _id });
    res.send({ success: true });
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});

// ===== SECTION 6: POST /borrows (copies + no double borrow) =====
app.post("/borrows", verifyToken, async (req, res) => {
  try {
    const { bookId } = req.body;
    if (!ObjectId.isValid(bookId)) {
      return res.status(400).send({ message: "Invalid book id" });
    }
    const db = await getDb();
    const borrows = db.collection("borrows");

    const already = await borrows.findOne({
      bookId,
      userEmail: req.user.email,
    });
    if (already) {
      return res
        .status(409)
        .send({ message: "You have already borrowed this book" });
    }

    const book = await db
      .collection("books")
      .findOneAndUpdate(
        { _id: new ObjectId(bookId), copies: { $gt: 0 } },
        { $inc: { copies: -1 } },
        { returnDocument: "after" }
      );
    if (!book) {
      return res.status(400).send({ message: "Book is not available" });
    }

    const borrowDate = new Date();
    const returnDate = new Date(borrowDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    const borrow = {
      bookId,
      bookTitle: book.title,
      bookImage: book.image,
      userName: req.user.name,
      userEmail: req.user.email,
      borrowDate,
      returnDate,
    };
    const result = await borrows.insertOne(borrow);
    res.send({ ...borrow, _id: result.insertedId });
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});

// ===== SECTION 7: GET /borrows, DELETE /borrows/:id =====
app.get("/borrows", verifyToken, async (req, res) => {
  try {
    const db = await getDb();
    const list = await db
      .collection("borrows")
      .find({ userEmail: req.user.email })
      .sort({ borrowDate: -1 })
      .toArray();
    res.send(list);
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});

app.delete("/borrows/:id", verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ message: "Invalid borrow id" });
    }
    const db = await getDb();
    const borrows = db.collection("borrows");
    const _id = new ObjectId(req.params.id);
    const borrow = await borrows.findOne({ _id });
    if (!borrow) return res.status(404).send({ message: "Borrow not found" });
    if (borrow.userEmail !== req.user.email) {
      return res.status(403).send({ message: "Forbidden" });
    }
    await borrows.deleteOne({ _id });
    await db
      .collection("books")
      .updateOne({ _id: new ObjectId(borrow.bookId) }, { $inc: { copies: 1 } });
    res.send({ success: true });
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});

module.exports = app;
if (require.main === module) {
  app.listen(process.env.PORT || 5000, () => console.log("Server on 5000"));
}