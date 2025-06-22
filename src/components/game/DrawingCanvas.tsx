import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import { useAuth } from "../../contexts/AuthContext";
import { supabase, DrawingStroke, DrawingPoint } from "../../lib/supabase";
import { Palette, Eraser, RotateCcw, Undo, Droplets } from "lucide-react";

type Tool = "brush" | "eraser" | "fill";

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
  const [currentTool, setCurrentTool] = useState<Tool>("brush");
  const [currentStroke, setCurrentStroke] = useState<DrawingPoint[]>([]);
  const [strokeHistory, setStrokeHistory] = useState<DrawingStroke[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const colors = [
    "#000000",
    "#FFFFFF",
    "#FF0000",
    "#00FF00",
    "#0000FF",
    "#FFFF00",
    "#FF00FF",
    "#00FFFF",
    "#FFA500",
    "#800080",
    "#008000",
    "#FFC0CB",
    "#A52A2A",
    "#808080",
    "#FFD700",
  ];

  const brushSizes = [2, 5, 10, 15, 20];

  // Debounced save function
  const debouncedSave = useMemo(() => {
    let timeoutId: NodeJS.Timeout;
    return (stroke: DrawingPoint[]) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        saveStroke(stroke);
      }, 100); // 100ms debounce
    };
  }, []);

  const saveStroke = async (stroke: DrawingPoint[]) => {
    if (stroke.length === 0) return;

    try {
      const { data, error } = await supabase
        .from("drawing_strokes")
        .insert([
          {
            game_id: gameId,
            points: stroke,
            color,
            brush_size: brushSize,
            tool: currentTool,
          },
        ])
        .select()
        .single();

      if (error) throw error;

      // Add to local history immediately
      if (data) {
        setStrokeHistory((prev) => [...prev, data]);
      }
    } catch (error) {
      console.error("Error saving stroke:", error);
    }
  };

  // Load existing strokes on component mount
  useEffect(() => {
    loadExistingStrokes();
  }, [gameId]);

  const loadExistingStrokes = async () => {
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("drawing_strokes")
        .select("*")
        .eq("game_id", gameId)
        .order("created_at", { ascending: true });

      if (error) throw error;

      if (data) {
        setStrokeHistory(data);
        // Redraw all strokes
        redrawCanvas(data);
      }
    } catch (error) {
      console.error("Error loading strokes:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const redrawCanvas = useCallback((strokes: DrawingStroke[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Redraw all strokes
    strokes.forEach((stroke) => {
      drawStrokeOnCanvas(ctx, stroke);
    });
  }, []);

  const drawStrokeOnCanvas = useCallback(
    (ctx: CanvasRenderingContext2D, stroke: DrawingStroke) => {
      if (stroke.tool === "fill") {
        // Handle fill tool
        if (stroke.points.length > 0) {
          const point = stroke.points[0];
          floodFill(ctx, point.x, point.y, stroke.color);
        }
      } else {
        // Handle brush and eraser tools
        ctx.strokeStyle = stroke.tool === "eraser" ? "#FFFFFF" : stroke.color;
        ctx.lineWidth = stroke.brush_size;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        if (stroke.points.length > 0) {
          ctx.beginPath();
          ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

          for (let i = 1; i < stroke.points.length; i++) {
            ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
          }

          ctx.stroke();
        }
      }
    },
    []
  );

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

    // Test drawing to ensure canvas is working
    ctx.strokeStyle = "red";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(10, 10);
    ctx.lineTo(50, 50);
    ctx.stroke();
  }, []); // Only run once on mount

  useEffect(() => {
    if (!gameId) return;

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
          // Add to local history and redraw
          setStrokeHistory((prev) => [...prev, newStroke]);
          const canvas = canvasRef.current;
          if (canvas) {
            const ctx = canvas.getContext("2d");
            if (ctx) {
              drawStrokeOnCanvas(ctx, newStroke);
            }
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "drawing_strokes",
          filter: `game_id=eq.${gameId}`,
        },
        () => {
          // Reload all strokes when something is deleted
          loadExistingStrokes();
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [gameId, drawStrokeOnCanvas, loadExistingStrokes]);

  // Flood fill algorithm
  const floodFill = (
    ctx: CanvasRenderingContext2D,
    startX: number,
    startY: number,
    fillColor: string
  ) => {
    const canvas = ctx.canvas;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    const startPos = (startY * canvas.width + startX) * 4;
    const startR = data[startPos];
    const startG = data[startPos + 1];
    const startB = data[startPos + 2];

    const fillColorRGB = hexToRgb(fillColor);
    if (!fillColorRGB) return;

    const stack: [number, number][] = [[startX, startY]];

    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      const pos = (y * canvas.width + x) * 4;

      if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) continue;
      if (
        data[pos] !== startR ||
        data[pos + 1] !== startG ||
        data[pos + 2] !== startB
      )
        continue;

      data[pos] = fillColorRGB.r;
      data[pos + 1] = fillColorRGB.g;
      data[pos + 2] = fillColorRGB.b;

      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    ctx.putImageData(imageData, 0, 0);
  };

  const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (readOnly || isLoading) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setIsDrawing(true);

    if (currentTool === "fill") {
      // For fill tool, we only need one point
      setCurrentStroke([
        { x, y, color, brush_size: brushSize, tool: currentTool },
      ]);
      // Execute fill immediately
      const ctx = canvas.getContext("2d");
      if (ctx) {
        floodFill(ctx, x, y, color);
      }
      stopDrawing();
    } else {
      setCurrentStroke([
        { x, y, color, brush_size: brushSize, tool: currentTool },
      ]);
    }
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || readOnly || currentTool === "fill" || isLoading) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newPoint = { x, y, color, brush_size: brushSize, tool: currentTool };

    // Draw immediately for smooth experience
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.strokeStyle = currentTool === "eraser" ? "#FFFFFF" : color;
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Get the current stroke points
    const currentPoints = [...currentStroke, newPoint];

    if (currentPoints.length >= 2) {
      const lastPoint = currentPoints[currentPoints.length - 2];
      ctx.beginPath();
      ctx.moveTo(lastPoint.x, lastPoint.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }

    // Update state after drawing
    setCurrentStroke(currentPoints);
  };

  const stopDrawing = async () => {
    if (!isDrawing || readOnly || isLoading) return;

    setIsDrawing(false);

    if (currentStroke.length > 0) {
      // Save stroke immediately for debugging
      await saveStroke(currentStroke);
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

      setStrokeHistory([]);
      setCanUndo(false);
    } catch (error) {
      console.error("Error clearing canvas:", error);
    }
  };

  const undo = async () => {
    if (strokeHistory.length === 0) return;

    try {
      const lastStroke = strokeHistory[strokeHistory.length - 1];

      // Delete the last stroke from database
      const { error } = await supabase
        .from("drawing_strokes")
        .delete()
        .eq("id", lastStroke.id);

      if (error) throw error;

      // Update local state
      setStrokeHistory((prev) => prev.slice(0, -1));
      setCanUndo(strokeHistory.length > 1);
    } catch (error) {
      console.error("Error undoing stroke:", error);
    }
  };

  // Update undo button state when stroke history changes
  useEffect(() => {
    setCanUndo(strokeHistory.length > 0);
  }, [strokeHistory]);

  if (isLoading) {
    return (
      <div className="canvas-container">
        <div className="flex items-center justify-center h-96 bg-gray-100 rounded-lg">
          <div className="text-gray-500">Loading canvas...</div>
        </div>
      </div>
    );
  }

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
        <div className="drawing-tools mt-4 p-4 bg-gray-100 rounded-lg">
          {/* Tool selection */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setCurrentTool("brush")}
              className={`p-2 rounded-md transition-colors ${
                currentTool === "brush"
                  ? "bg-blue-500 text-white"
                  : "bg-white text-gray-700 hover:bg-gray-200"
              }`}
              title="Brush tool"
            >
              <Palette className="h-5 w-5" />
            </button>
            <button
              onClick={() => setCurrentTool("eraser")}
              className={`p-2 rounded-md transition-colors ${
                currentTool === "eraser"
                  ? "bg-blue-500 text-white"
                  : "bg-white text-gray-700 hover:bg-gray-200"
              }`}
              title="Eraser tool"
            >
              <Eraser className="h-5 w-5" />
            </button>
            <button
              onClick={() => setCurrentTool("fill")}
              className={`p-2 rounded-md transition-colors ${
                currentTool === "fill"
                  ? "bg-blue-500 text-white"
                  : "bg-white text-gray-700 hover:bg-gray-200"
              }`}
              title="Fill tool"
            >
              <Droplets className="h-5 w-5" />
            </button>
          </div>

          {/* Color picker */}
          <div className="grid grid-cols-5 gap-1 mb-4">
            {colors.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-md border-2 transition-all ${
                  color === c ? "border-blue-500 scale-110" : "border-gray-300"
                }`}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>

          {/* Brush size */}
          <div className="flex gap-2 mb-4">
            {brushSizes.map((size) => (
              <button
                key={size}
                onClick={() => setBrushSize(size)}
                className={`w-8 h-8 rounded-md border-2 transition-all flex items-center justify-center text-xs font-bold ${
                  brushSize === size
                    ? "border-blue-500 bg-blue-500 text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-200"
                }`}
                title={`Brush size: ${size}`}
              >
                {size}
              </button>
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={undo}
              disabled={!canUndo}
              className={`p-2 rounded-md transition-colors flex items-center gap-2 ${
                canUndo
                  ? "bg-yellow-500 text-white hover:bg-yellow-600"
                  : "bg-gray-300 text-gray-500 cursor-not-allowed"
              }`}
              title="Undo last stroke"
            >
              <Undo className="h-4 w-4" />
              Undo
            </button>
            <button
              onClick={clearCanvas}
              className="p-2 bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors flex items-center gap-2"
              title="Clear canvas"
            >
              <RotateCcw className="h-4 w-4" />
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DrawingCanvas;
