// Verify the real duplicate pairs are detected by the actual SQL.
import pg from "pg";
import { readFileSync } from "fs";
const env = readFileSync("/tmp/b-guru/.env.local", "utf8");
