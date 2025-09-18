// src/index.js
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
