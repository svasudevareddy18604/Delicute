const express = require('express');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const pool = require('../db');
const router = express.Router();

// Configure Multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// JWT Middleware
const authenticateJWT = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Access denied, no token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Seed initial data
async function seedInitialData() {
  try {
    const [categories] = await pool.query('SELECT COUNT(*) AS count FROM categories');
    if (categories[0].count === 0) {
      await pool.query('INSERT INTO categories (name) VALUES (?), (?)', ['Main Course', 'Desserts']);
      console.log('Seeded initial categories');
    }

    const [menuItems] = await pool.query('SELECT COUNT(*) AS count FROM menu_items');
    if (menuItems[0].count === 0) {
      await pool.query(
        'INSERT INTO menu_items (name, description, original_price, image_url, category_id, saved_price) VALUES (?, ?, ?, ?, ?, ?)',
        ['Sample Dish', 'A delicious sample dish', 100.00, 'https://via.placeholder.com/80', 1, 80.00]
      );
      console.log('Seeded initial menu item');
    }
  } catch (error) {
    console.error('Error seeding initial data:', error);
  }
}

seedInitialData();

// Menu Items Routes
router.get('/menu', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT mi.*, c.name AS category
      FROM menu_items mi
      LEFT JOIN categories c ON mi.category_id = c.id
    `);
    res.json(rows.map(item => ({
      _id: item.id,
      name: item.name,
      description: item.description,
      category: item.category,
      image: item.image_url,
      originalPrice: parseFloat(item.original_price),
      savedPrice: item.saved_price ? parseFloat(item.saved_price) : null
    })));
  } catch (error) {
    console.error('Error fetching menu items:', error);
    res.status(500).json({ error: 'Failed to fetch menu items' });
  }
});

router.post('/menu', authenticateJWT, upload.single('image'), async (req, res) => {
  try {
    let imageUrl = null;
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'delicute_images' }, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }).end(req.file.buffer);
      });
      imageUrl = result.secure_url;
    } else {
      return res.status(400).json({ error: 'Image is required' });
    }

    const { name, description, category, originalPrice, savedPrice } = req.body;
    if (!name || !category || !originalPrice) {
      return res.status(400).json({ error: 'Name, category, and original price are required' });
    }

    const [categoryRows] = await pool.query('SELECT id FROM categories WHERE name = ?', [category]);
    if (categoryRows.length === 0) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    const categoryId = categoryRows[0].id;

    const [result] = await pool.query(
      'INSERT INTO menu_items (name, description, original_price, image_url, category_id, saved_price) VALUES (?, ?, ?, ?, ?, ?)',
      [name, description, parseFloat(originalPrice), imageUrl, categoryId, savedPrice ? parseFloat(savedPrice) : null]
    );

    res.status(201).json({
      _id: result.insertId,
      name,
      description,
      category,
      image: imageUrl,
      originalPrice: parseFloat(originalPrice),
      savedPrice: savedPrice ? parseFloat(savedPrice) : null
    });
  } catch (error) {
    console.error('Error adding menu item:', error);
    res.status(500).json({ error: 'Failed to add menu item' });
  }
});

router.put('/menu/:id', authenticateJWT, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, category, originalPrice, savedPrice } = req.body;
    if (!name || !category || !originalPrice) {
      return res.status(400).json({ error: 'Name, category, and original price are required' });
    }

    const [categoryRows] = await pool.query('SELECT id FROM categories WHERE name = ?', [category]);
    if (categoryRows.length === 0) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    const categoryId = categoryRows[0].id;

    let imageUrl = null;
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'delicute_images' }, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }).end(req.file.buffer);
      });
      imageUrl = result.secure_url;
    } else {
      const [existing] = await pool.query('SELECT image_url FROM menu_items WHERE id = ?', [id]);
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Menu item not found' });
      }
      imageUrl = existing[0].image_url;
    }

    await pool.query(
      'UPDATE menu_items SET name = ?, description = ?, original_price = ?, image_url = ?, category_id = ?, saved_price = ? WHERE id = ?',
      [name, description, parseFloat(originalPrice), imageUrl, categoryId, savedPrice ? parseFloat(savedPrice) : null, id]
    );

    res.json({ message: 'Menu item updated successfully' });
  } catch (error) {
    console.error('Error updating menu item:', error);
    res.status(500).json({ error: 'Failed to update menu item' });
  }
});

router.delete('/menu/:id', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM menu_items WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting menu item:', error);
    res.status(500).json({ error: 'Failed to delete menu item' });
  }
});

// Category Routes
router.get('/categories', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id AS _id, name FROM categories');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

router.post('/categories', authenticateJWT, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    const [existing] = await pool.query('SELECT id FROM categories WHERE name = ?', [name]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    const [result] = await pool.query('INSERT INTO categories (name) VALUES (?)', [name]);
    res.status(201).json({ _id: result.insertId, name });
  } catch (error) {
    console.error('Error adding category:', error);
    res.status(500).json({ error: 'Failed to add category' });
  }
});

router.put('/categories/:id', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    const [existing] = await pool.query('SELECT id FROM categories WHERE name = ? AND id != ?', [name, id]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    const [result] = await pool.query('UPDATE categories SET name = ? WHERE id = ?', [name, id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }
    res.json({ message: 'Category updated successfully' });
  } catch (error) {
    console.error('Error updating category:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

router.delete('/categories/:id', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const [menuItems] = await pool.query('SELECT id FROM menu_items WHERE category_id = ?', [id]);
    const [coupons] = await pool.query('SELECT id FROM coupons WHERE category_id = ?', [id]);
    if (menuItems.length > 0 || coupons.length > 0) {
      return res.status(400).json({ error: 'Cannot delete category used by menu items or coupons' });
    }
    const [result] = await pool.query('DELETE FROM categories WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// Order Routes
router.get('/orders', authenticateJWT, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM orders');
    res.json(rows.map(order => ({
      _id: order.id,
      orderId: order.id,
      customerName: order.customer_name,
      table: order.table_number,
      items: order.items ? JSON.parse(order.items) : [],
      totalAmount: parseFloat(order.total_amount),
      instructions: order.instructions,
      status: order.status
    })));
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.put('/orders/:id', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const { instructions, status } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    const [result] = await pool.query(
      'UPDATE orders SET instructions = ?, status = ? WHERE id = ?',
      [instructions || null, status, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ message: 'Order updated successfully' });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

router.delete('/orders/:id', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM orders WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// Coupon Routes
router.get('/coupons', authenticateJWT, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.*, cat.name AS category
      FROM coupons c
      LEFT JOIN categories cat ON c.category_id = cat.id
    `);
    res.json(rows.map(coupon => ({
      _id: coupon.id,
      image: coupon.image_url,
      code: coupon.code,
      description: coupon.description,
      buyX: coupon.buy_x,
      discount: coupon.discount,
      category: coupon.category || null,
      validFrom: coupon.valid_from,
      validTo: coupon.valid_to
    })));
  } catch (error) {
    console.error('Error fetching coupons:', error);
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
});

router.post('/coupons', authenticateJWT, upload.single('image'), async (req, res) => {
  try {
    let imageUrl = null;
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'delicute_images' }, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }).end(req.file.buffer);
      });
      imageUrl = result.secure_url;
    } else {
      return res.status(400).json({ error: 'Image is required' });
    }

    const { code, description, buyX, discount, category, validFrom, validTo } = req.body;
    if (!code || !description || !buyX || !discount || !validFrom || !validTo) {
      return res.status(400).json({ error: 'All required fields must be provided' });
    }

    let categoryId = null;
    if (category) {
      const [categoryRows] = await pool.query('SELECT id FROM categories WHERE name = ?', [category]);
      if (categoryRows.length === 0) {
        return res.status(400).json({ error: 'Invalid category' });
      }
      categoryId = categoryRows[0].id;
    }

    const [existing] = await pool.query('SELECT id FROM coupons WHERE code = ?', [code]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Coupon code already exists' });
    }

    const [result] = await pool.query(
      'INSERT INTO coupons (image_url, code, description, buy_x, discount, category_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [imageUrl, code, description, parseInt(buyX), parseInt(discount), categoryId, validFrom, validTo]
    );

    res.status(201).json({
      _id: result.insertId,
      image: imageUrl,
      code,
      description,
      buyX: parseInt(buyX),
      discount: parseInt(discount),
      category: category || null,
      validFrom,
      validTo
    });
  } catch (error) {
    console.error('Error adding coupon:', error);
    res.status(500).json({ error: 'Failed to add coupon' });
  }
});

router.put('/coupons/:id', authenticateJWT, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { code, description, buyX, discount, category, validFrom, validTo } = req.body;
    if (!code || !description || !buyX || !discount || !validFrom || !validTo) {
      return res.status(400).json({ error: 'All required fields must be provided' });
    }

    let imageUrl = null;
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'delicute_images' }, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }).end(req.file.buffer);
      });
      imageUrl = result.secure_url;
    } else {
      const [existing] = await pool.query('SELECT image_url FROM coupons WHERE id = ?', [id]);
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Coupon not found' });
      }
      imageUrl = existing[0].image_url;
    }

    let categoryId = null;
    if (category) {
      const [categoryRows] = await pool.query('SELECT id FROM categories WHERE name = ?', [category]);
      if (categoryRows.length === 0) {
        return res.status(400).json({ error: 'Invalid category' });
      }
      categoryId = categoryRows[0].id;
    }

    const [existing] = await pool.query('SELECT id FROM coupons WHERE code = ? AND id != ?', [code, id]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Coupon code already exists' });
    }

    const [result] = await pool.query(
      'UPDATE coupons SET image_url = ?, code = ?, description = ?, buy_x = ?, discount = ?, category_id = ?, valid_from = ?, valid_to = ? WHERE id = ?',
      [imageUrl, code, description, parseInt(buyX), parseInt(discount), categoryId, validFrom, validTo, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Coupon not found' });
    }

    res.json({ message: 'Coupon updated successfully' });
  } catch (error) {
    console.error('Error updating coupon:', error);
    res.status(500).json({ error: 'Failed to update coupon' });
  }
});

router.delete('/coupons/:id', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM coupons WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Coupon not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting coupon:', error);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

// Top Picks Routes
router.get('/top-picks', authenticateJWT, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT tp.id AS _id, mi.id AS menuItemId, mi.name, mi.image_url AS image, c.name AS category
      FROM top_picks tp
      JOIN menu_items mi ON tp.menu_item_id = mi.id
      LEFT JOIN categories c ON mi.category_id = c.id
    `);
    res.json(rows.map(row => ({
      _id: row._id,
      menuItem: {
        _id: row.menuItemId,
        name: row.name,
        image: row.image,
        category: row.category
      }
    })));
  } catch (error) {
    console.error('Error fetching top picks:', error);
    res.status(500).json({ error: 'Failed to fetch top picks' });
  }
});

router.post('/top-picks', authenticateJWT, async (req, res) => {
  try {
    const { menuItemId } = req.body;
    if (!menuItemId) {
      return res.status(400).json({ error: 'Menu item ID is required' });
    }
    const [menuItem] = await pool.query('SELECT id FROM menu_items WHERE id = ?', [menuItemId]);
    if (menuItem.length === 0) {
      return res.status(400).json({ error: 'Invalid menu item ID' });
    }
    const [existing] = await pool.query('SELECT id FROM top_picks WHERE menu_item_id = ?', [menuItemId]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Menu item is already a top pick' });
    }
    const [result] = await pool.query('INSERT INTO top_picks (menu_item_id) VALUES (?)', [menuItemId]);
    res.status(201).json({ _id: result.insertId, menuItemId });
  } catch (error) {
    console.error('Error adding top pick:', error);
    res.status(500).json({ error: 'Failed to add top pick' });
  }
});

router.delete('/top-picks/:id', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM top_picks WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Top pick not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting top pick:', error);
    res.status(500).json({ error: 'Failed to delete top pick' });
  }
});

module.exports = router;