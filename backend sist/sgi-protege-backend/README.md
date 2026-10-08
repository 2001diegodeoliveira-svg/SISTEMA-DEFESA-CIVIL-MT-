### Technology Stack

1. **Programming Language**: Node.js (JavaScript) or Python (Flask/Django)
2. **Database**: PostgreSQL
3. **ORM**: Sequelize (for Node.js) or SQLAlchemy (for Python)
4. **API Framework**: Express.js (for Node.js) or Flask/Django REST Framework (for Python)
5. **Authentication**: JWT (JSON Web Tokens)
6. **Environment Variables**: dotenv for managing configuration

### Database Schema

Here’s a simple schema that could be used for the project:

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL, -- e.g., admin, user
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE incidents (
    id SERIAL PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    location GEOGRAPHY(Point, 4326),
    status VARCHAR(20) NOT NULL, -- e.g., reported, in progress, resolved
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reports (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    incident_id INT REFERENCES incidents(id),
    report_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### API Endpoints

Here are some example API endpoints that you might implement:

#### User Authentication

- **POST /api/auth/register**: Register a new user
- **POST /api/auth/login**: Authenticate a user and return a JWT

#### Incident Management

- **GET /api/incidents**: Retrieve a list of incidents
- **POST /api/incidents**: Create a new incident
- **GET /api/incidents/:id**: Retrieve a specific incident by ID
- **PUT /api/incidents/:id**: Update an existing incident
- **DELETE /api/incidents/:id**: Delete an incident

#### Reporting

- **GET /api/reports**: Retrieve all reports
- **POST /api/reports**: Create a new report for an incident
- **GET /api/reports/:id**: Retrieve a specific report by ID

### Implementation Steps

1. **Set Up the Environment**:
   - Install Node.js or Python.
   - Set up PostgreSQL and create a database for the project.
   - Use an ORM to interact with the database.

2. **Create the Database**:
   - Use the SQL schema provided above to create the necessary tables.

3. **Implement User Authentication**:
   - Create endpoints for user registration and login.
   - Use bcrypt to hash passwords and JWT for token generation.

4. **Implement Incident Management**:
   - Create endpoints to manage incidents, including CRUD operations.
   - Ensure that only authenticated users can create or modify incidents.

5. **Implement Reporting**:
   - Create endpoints for users to report incidents.
   - Link reports to users and incidents.

6. **Testing**:
   - Write unit tests for your API endpoints.
   - Use tools like Postman or Insomnia to manually test the API.

7. **Documentation**:
   - Document your API using Swagger or Postman.

### Example Code Snippet (Node.js with Express)

Here’s a simple example of how you might set up an Express server with a couple of endpoints:

```javascript
const express = require('express');
const bodyParser = require('body-parser');
const { Sequelize } = require('sequelize');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
app.use(bodyParser.json());

// Initialize Sequelize
const sequelize = new Sequelize('postgres://user:password@localhost:5432/sgi_protege');

// Define User model
const User = sequelize.define('User', {
    username: { type: Sequelize.STRING, unique: true },
    password: Sequelize.STRING,
    role: Sequelize.STRING,
});

// User registration
app.post('/api/auth/register', async (req, res) => {
    const { username, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hashedPassword, role });
    res.status(201).json(user);
});

// User login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ where: { username } });
    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ id: user.id, role: user.role }, 'your_jwt_secret');
        res.json({ token });
    } else {
        res.status(401).json({ message: 'Invalid credentials' });
    }
});

// Start the server
app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
```

### Conclusion

This is a high-level overview of how to develop a backend system for the "SGI PROTEGE - Estado de Mato Grosso" project. You can expand upon this foundation by adding more features, improving security, and optimizing performance based on the specific requirements of the project.