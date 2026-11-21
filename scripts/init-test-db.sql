-- Creates the test database if it does not already exist
SELECT 'CREATE DATABASE marbou_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'marbou_test')\gexec
