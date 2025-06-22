import React, { useRef, useEffect, useState, useCallback } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { supabase, DrawingStroke, DrawingPoint } from "../../lib/supabase";
import { Palette, Eraser, RotateCcw } from "lucide-react";

interface DrawingCanvasProps {
  gameId: string;
  readOnly?: boolean;
}

const DrawingCanvas: React.FC<DrawingCanvasProps> = ({
  gameId,
  readOnly = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { user } = useAuth();
  const [isDrawing, setIsDrawing] = useState(false);
  const [color, setColor] = useState("#000000");
  const [brushSize, setBrushSize] = useState(5);
  const [currentStroke, setCurrentStroke] = useState<DrawingPoint[]>([]);

  const colors = [
    "#000000",
    "#FF0000",
    "#00FF00",
    "#0000FF",
    "#FFFF00",
    "#FF00FF",
    "#00FFFF",
    "#FFA500",
    "#800080",
    "#008000",
  ];

  const brushSizes = [2, 5, 10, 15, 20];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size
    canvas.width = 600;
    canvas.height = 400;

    // Set default styles
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Subscribe to drawing updates
    const subscription = supabase
      .channel(`drawing:${gameId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "drawing_strokes",
          filter: `game_id=eq.${gameId}`,
        },
        (payload) => {
          const newStroke = payload.new as DrawingStroke;
          drawStroke(newStroke);
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [gameId]);

  const drawStroke = useCallback((stroke: DrawingStroke) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.brush_size;

    if (stroke.points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }

      ctx.stroke();
    }
  }, []);

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (readOnly) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setIsDrawing(true);
    setCurrentStroke([{ x, y, color, brush_size: brushSize }]);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || readOnly) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setCurrentStroke((prev) => [
      ...prev,
      { x, y, color, brush_size: brushSize },
    ]);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (currentStroke.length > 0) {
      const lastPoint = currentStroke[currentStroke.length - 1];
      ctx.beginPath();
      ctx.moveTo(lastPoint.x, lastPoint.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  };

  const stopDrawing = async () => {
    if (!isDrawing || readOnly) return;

    setIsDrawing(false);

    if (currentStroke.length > 0) {
      try {
        const { error } = await supabase.from("drawing_strokes").insert([
          {
            game_id: gameId,
            points: currentStroke,
            color,
            brush_size: brushSize,
          },
        ]);

        if (error) throw error;
      } catch (error) {
        console.error("Error saving stroke:", error);
      }
    }

    setCurrentStroke([]);
  };

  const clearCanvas = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Clear all strokes from database
    try {
      const { error } = await supabase
        .from("drawing_strokes")
        .delete()
        .eq("game_id", gameId);

      if (error) throw error;
    } catch (error) {
      console.error("Error clearing canvas:", error);
    }
  };

  return (
    <div className="canvas-container">
      <canvas
        ref={canvasRef}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
        className="border border-gray-300 rounded-lg"
        style={{ cursor: readOnly ? "default" : "crosshair" }}
      />

      {!readOnly && (
        <div className="drawing-tools">
          {/* Color picker */}
          <div className="grid grid-cols-2 gap-1">
            {colors.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className="color-picker"
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>

          {/* Brush size */}
          <div className="space-y-1">
            {brushSizes.map((size) => (
              <button
                key={size}
                onClick={() => setBrushSize(size)}
                className={`brush-size ${
                  brushSize === size ? "ring-2 ring-blue-500" : ""
                }`}
                title={`Brush size: ${size}`}
              >
                {size}
              </button>
            ))}
          </div>

          {/* Clear button */}
          <button
            onClick={clearCanvas}
            className="w-10 h-10 bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors flex items-center justify-center"
            title="Clear canvas"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
};

export default DrawingCanvas;
