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
    status VARCHAR(20) NOT NULL, -- e.g., reported, in_progress, resolved
    location GEOGRAPHY(Point, 4326), -- Store location as latitude/longitude
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reports (
    id SERIAL PRIMARY KEY,
    incident_id INT REFERENCES incidents(id),
    user_id INT REFERENCES users(id),
    report TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);