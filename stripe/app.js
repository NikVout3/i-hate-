const express = require("express");
const cors = require("cors");
const { readFileSync } = require("fs");
const { join } = require("path");
const Stripe = require("stripe");
const dotenv = require("dotenv");
const axios = require("axios");
const axiosRetry = require("axios-retry").default;
const mongoose = require("mongoose");
const crypto = require("crypto");

// Configure axiosRetry globally
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

dotenv.config();

// Validate required environment variables.
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing Stripe Secret Key in environment variables");
}
if (!process.env.MONGO_URI) {
  throw new Error("Missing MongoDB connection string in environment variables (MONGO_URI)");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;

// Connect to MongoDB.
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

// Enable CORS with proper configuration
app.use(cors({
  origin: '*', // Allow all origins for now
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Shop-ID']
}));

// Use JSON parser for all routes except the webhook.
app.use((req, res, next) => {
  if (req.path === "/webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// ----- Mongoose Schemas ----- //

// Cart Schema (temporary cart data, auto-expiring after 1 hour)
const cartSchema = new mongoose.Schema({
  cartKey: { type: String, required: true, unique: true },
  cartData: { type: Object, required: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 } // TTL index: cart expires in 1 hour.
});
const Cart = mongoose.model("Cart", cartSchema);

// Order Schema (persistent order details)
const orderSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  line_items: { type: Array, required: true },
  currency: { type: String, required: true },
  fulfillment: { type: Object },
  shopifyOrderId: { type: String },
  shopId: { type: String, required: true }, // Add the shop ID field
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model("Order", orderSchema);

// Shop Token Schema (for associating shop IDs with checkout tokens)
const shopTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  shopId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 } // TTL index: token expires in 1 hour.
});
const ShopToken = mongoose.model("ShopToken", shopTokenSchema);

// ----- Helper Functions ----- //

// Generate a random string (used for cart keys and tokens)
function generateRandomString(length) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Get shop ID from various sources
async function determineShopId(req) {
  // Try different approaches in order of preference
  
  // 1. Try to get from checkout token if present
  if (req.body && req.body.checkout_token) {
    try {
      const shopTokenRecord = await ShopToken.findOne({ token: req.body.checkout_token });
      if (shopTokenRecord) {
        console.log(`Found shop ${shopTokenRecord.shopId} using token ${req.body.checkout_token}`);
        return shopTokenRecord.shopId;
      }
    } catch (err) {
      console.error("Error looking up token:", err);
    }
  }
  
  // 2. Try to get from X-Shop-ID header
  if (req.headers && req.headers['x-shop-id']) {
    const shopId = req.headers['x-shop-id'];
    console.log(`Using shop ID from X-Shop-ID header: ${shopId}`);
    return shopId;
  }
  
  // 3. Try to get from referer
  if (req.headers && req.headers.referer) {
    try {
      const url = new URL(req.headers.referer);
      const domain = url.hostname;
      console.log(`Extracted shop ID from referer: ${domain}`);
      return domain;
    } catch (err) {
      console.error("Error parsing referer:", err);
    }
  }
  
  // 4. Try to get from origin
  if (req.headers && req.headers.origin) {
    try {
      const url = new URL(req.headers.origin);
      const domain = url.hostname;
      console.log(`Extracted shop ID from origin: ${domain}`);
      return domain;
    } catch (err) {
      console.error("Error parsing origin:", err);
    }
  }
  
  // 5. Default to hellservices.shop
  console.log("Using default shop ID: hellservices.shop");
  return "hellservices.shop";
}

// Optionally load random titles from titles.txt
let randomTitles = [];
try {
  const data = readFileSync(join(__dirname, "titles.txt"), "utf8");
  randomTitles = data.split(/\r?\n/).filter(line => line.trim() !== "");
  if (randomTitles.length === 0) {
    console.error("No titles found in titles.txt");
  }
} catch (err) {
  console.error("Error reading titles.txt:", err);
}

// ----- Endpoints ----- //

/* 
  POST /register-shop
  - Receives a shop_id from the client
  - Generates a unique token and stores it with the shop_id
  - Returns the token to the client
*/
app.post("/register-shop", async (req, res) => {
  try {
    // Get shop_id from request body or determine it from request
    let shop_id = req.body.shop_id;
    
    if (!shop_id) {
      shop_id = await determineShopId(req);
    }
    
    // Generate a unique token
    const token = crypto.randomBytes(16).toString('hex');
    
    // Store the token and shop_id
    await ShopToken.create({ token, shopId: shop_id });
    
    console.log(`Registered shop ${shop_id} with token ${token}`);
    
    // Return the token to the client
    res.json({ token });
  } catch (error) {
    console.error("Error registering shop:", error);
    res.status(500).json({ error: error.message });
  }
});

/* 
  POST /create-checkout-session
  - Validates Shopify cart JSON from the client.
  - Determines the shop_id from various sources.
  - Saves the cart data in MongoDB.
  - Creates a Stripe Checkout session.
  - Returns the session URL.
*/
app.post("/create-checkout-session", async (req, res) => {
  try {
    const cart = req.body; // Expecting Shopify's /cart.js JSON format
    console.log("Create checkout session request body:", req.body);
    
    // Get shop ID using our helper function
    const shopId = await determineShopId(req);
    console.log(`Using shop ID for checkout: ${shopId}`);
    
    // Remove checkout_token if it exists before saving the cart
    if (cart.checkout_token) {
      delete cart.checkout_token;
    }
    
    if (!cart || !cart.items || !Array.isArray(cart.items) || cart.items.length === 0 || !cart.currency) {
      return res.status(400).json({ error: "Cart is empty, invalid, or missing currency" });
    }
    
    const cartKey = generateRandomString(16);

    // Save cart data in the database.
    await Cart.create({ cartKey, cartData: cart });

    // Enforce USD currency.
    if (cart.currency.toLowerCase() !== "usd") {
      return res.status(400).json({ error: "Currency must be USD" });
    }

    // Calculate the discount from the cart.
    const totalDiscount = cart.total_discount || 0;

    // Build line items for Stripe Checkout.
    const lineItems = cart.items.map(item => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: randomTitles.length > 0
            ? randomTitles[Math.floor(Math.random() * randomTitles.length)]
            : item.title,
        },
        unit_amount: Math.round(item.price * 1), // price in cents
      },
      quantity: item.quantity,
    }));

    // Prepare the parameters for the Checkout Session.
    const sessionParams = {
      payment_method_types: ["card"],
      mode: "payment",
      line_items: lineItems,
      success_url: process.env.SUCCESS_URL || "https://www.example.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: process.env.CANCEL_URL || "https://www.example.com/cancel",
      metadata: { cart_key: cartKey, shop_id: shopId },
    };
    
    console.log("Session params metadata:", sessionParams.metadata);

    // If there is a discount, create a coupon and add it to the session.
    if (totalDiscount > 0) {
      // Calculate the total amount (in cents) of all items.
      const totalAmount = lineItems.reduce((sum, item) =>
        sum + item.price_data.unit_amount * item.quantity, 0);

      // The discount should not exceed the total amount.
      const discountCents = Math.min(totalAmount, Math.round(totalDiscount * 1));
      
      // Create a one-time coupon for the discount.
      const coupon = await stripe.coupons.create({
        amount_off: discountCents,
        currency: "usd",
        duration: "once",
      });

      sessionParams.discounts = [{ coupon: coupon.id }];
    }

    // Create the Stripe Checkout session.
    const session = await stripe.checkout.sessions.create(sessionParams);
    
    console.log("Created session metadata:", session.metadata);

    // Return the session URL for redirecting the user.
    res.json({ url: session.url });
  } catch (error) {
    console.error("Error creating Checkout session:", error);
    res.status(500).json({ error: error.message });
  }
});

/* 
  POST /webhook
  - Verifies the Stripe webhook signature.
  - Retrieves the cart from the database using the cart_key.
  - Creates an order summary and stores it in the Order collection.
  - Sends the order payload to Zapier.
*/
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      console.error("Raw body:", req.body.toString());
      return res.sendStatus(400);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("Received webhook for session:", session.id);
      
      console.log("Session metadata received:", session.metadata);
      
      const cartKey = (session.metadata && session.metadata.cart_key) || "UNKNOWN_CART";
      // Extract the shop ID from the session metadata
const shopId = (session.metadata && (session.metadata.shop_id || session.metadata.shopId)) || "UNKNOWN_SHOP";
      
      console.log("Extracted shopId from metadata:", shopId);
      
      if (cartKey === "UNKNOWN_CART") {
        console.error("Received webhook with unknown cart key");
        return res.status(400).json({ error: "Unknown cart key" });
      }
      
      try {
        // Retrieve cart data from the database.
        const cartRecord = await Cart.findOne({ cartKey });
        if (cartRecord) {
          const cartData = cartRecord.cartData;
          
          // Optionally remove the cart after processing.
          await Cart.deleteOne({ cartKey });

          // Build an order summary.
          const orderSummary = {
            sessionId: session.id,
            email: (session.customer_details && session.customer_details.email) || "customer@example.com",
            line_items: cartData.items.map(item => ({
              title: item.title,
              quantity: item.quantity,
              price: Number(item.price).toFixed(2),
              variant_id: item.variant_id || "default_variant",
            })),
            currency: "USD",
            fulfillment: cartData.attributes || {},
            shopId: shopId  // Store the shop ID with the order
          };

          // Save the order summary in the database.
          const newOrder = await Order.create(orderSummary);
          console.log("Order created:", newOrder);
          
          // Pass shopId to your Zapier function
          console.log("Passing shopId to sendOrderToZapier:", shopId);
          sendOrderToZapier(session, cartData, shopId);
        } else {
          console.error("Cart data not found for key:", cartKey);
        }
      } catch (dbError) {
        console.error("Database error:", dbError);
      }
    }
    res.json({ received: true });
  }
);

/* 
  GET /order-details
  - Retrieves order details from the Order collection.
  - Expects a query parameter `session_id`.
*/
app.get("/order-details", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) {
    return res.status(400).json({ error: "Missing session_id" });
  }
  try {
    const order = await Order.findOne({ sessionId });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json(order);
  } catch (error) {
    console.error("Error retrieving order details:", error);
    res.status(500).json({ error: error.message });
  }
});

/* 
  POST /update-order
  - Receives a Shopify order id from Zapier along with the corresponding Stripe session id.
  - Updates the order in the database with the Shopify order id.
  - Includes additional logging to help debug.
*/
app.post("/update-order", async (req, res) => {
  console.log("Update-order payload:", req.body);
  const { sessionId, shopifyOrderId } = req.body;
  if (!sessionId || !shopifyOrderId) {
    console.error("Missing fields in /update-order:", req.body);
    return res.status(400).json({ error: "Missing sessionId or shopifyOrderId" });
  }
  try {
    const updatedOrder = await Order.findOneAndUpdate(
      { sessionId },
      { $set: { shopifyOrderId } },
      { new: true }
    );
    if (!updatedOrder) {
      console.error("Order not found for sessionId:", sessionId);
      return res.status(404).json({ error: "Order not found" });
    }
    console.log("Order updated with shopifyOrderId:", updatedOrder);
    res.json(updatedOrder);
  } catch (err) {
    console.error("Error updating order with shopifyOrderId:", err);
    res.status(500).json({ error: err.message });
  }
});

/* 
  Helper: sendOrderToZapier
  - Sends the order payload to Zapier using axios with retry logic.
*/
async function sendOrderToZapier(session, cartData, shopId) {
  console.log("sendOrderToZapier called with shopId:", shopId);
  
  if (!cartData.items || !Array.isArray(cartData.items) || cartData.items.length === 0) {
    console.error("No items found in cart data.");
    return;
  }

  // Compute overall final price from the Stripe session (in dollars)
  const finalPrice = session.amount_total ? (session.amount_total / 100).toFixed(2) : "0.00";
  // Compute the subtotal (in cents) from session.amount_subtotal or recalc from cartData.
  const subtotalCents = session.amount_subtotal || cartData.items.reduce((sum, item) => {
    return sum + Math.round(Number(item.price) * 100) * (item.quantity || 1);
  }, 0);
  // Discount in cents is the difference between subtotal and final amount.
  const discountCents = subtotalCents - (session.amount_total || subtotalCents);
  // Calculate discount in dollars.
  const discount = (discountCents / 100).toFixed(2);

  // Recalculate each line item's discounted unit price proportionally.
  const final_line_items = cartData.items.map(item => {
    const quantity = item.quantity || 1;
    const originalUnitCents = Math.round(Number(item.price) * 100);
    const originalItemTotal = originalUnitCents * quantity;
    const itemDiscount = subtotalCents > 0 ? Math.round(originalItemTotal / subtotalCents * discountCents) : 0;
    const finalItemTotal = originalItemTotal - itemDiscount;
    const finalUnitPrice = (finalItemTotal / quantity / 100).toFixed(2);
    return {
      title: item.title || "Product",
      quantity: quantity,
      original_price: Number(item.price).toFixed(2),
      final_price: finalUnitPrice,
      variant_id: item.variant_id || process.env.DEFAULT_VARIANT_ID || "default_variant"
    };
  });

  // Get email from the session.
  const email = (session.customer_details && session.customer_details.email) || "customer@example.com";
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error("Invalid email address:", email);
    return;
  }
  
  const orderPayload = {
    email: email,
    stripe_session_id: session.id,
    shop_id: shopId, // Include the shop ID in the Zapier payload
    line_items: final_line_items,
    currency: "USD",
    final_price: finalPrice, // Overall discounted total price from Stripe.
    discount: discount,     // Stripe discount amount (in dollars).
    payment_status: "paid"
  };

  console.log("Sending order payload to Zapier with shopId:", shopId);
  console.log("Full order payload:", JSON.stringify(orderPayload, null, 2));

  try {
    const response = await axios.post(process.env.ZAPIER_WEBHOOK_URL, orderPayload, {
      headers: { "Content-Type": "application/json" }
    });
    console.log("Order sent to Zapier successfully:", response.data);
  } catch (error) {
    console.error("Error sending order to Zapier:", error.response ? error.response.data : error.message);
  }
}

// Health-check endpoint.
app.get("/", (req, res) => {
  res.send("Stripe Checkout Service is running.");
});

// Start the Express server.
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});