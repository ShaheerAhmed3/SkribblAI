import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL!;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Database types
export interface User {
  id: string;
  email: string;
  username: string;
  created_at: string;
}

export interface Game {
  id: string;
  name: string;
  status: "waiting" | "playing" | "finished";
  current_word?: string;
  current_drawer?: string;
  round: number;
  max_rounds: number;
  created_at: string;
  updated_at: string;
}

export interface GamePlayer {
  id: string;
  game_id: string;
  user_id: string;
  username: string;
  score: number;
  is_drawing: boolean;
  joined_at: string;
}

export interface ChatMessage {
  id: string;
  game_id: string;
  user_id: string;
  username: string;
  message: string;
  is_guess: boolean;
  is_correct: boolean;
  created_at: string;
}

export interface DrawingPoint {
  x: number;
  y: number;
  color: string;
  brush_size: number;
  tool?: "brush" | "eraser" | "fill";
}

export interface DrawingStroke {
  id: string;
  game_id: string;
  points: DrawingPoint[];
  color: string;
  brush_size: number;
  tool: "brush" | "eraser" | "fill";
  created_at: string;
}
