export const loadWordList = async (): Promise<string[]> => {
  try {
    const response = await fetch("/words.txt");
    if (!response.ok) {
      throw new Error(`Failed to fetch words list: ${response.status}`);
    }
    const text = await response.text();
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    console.error(error);
    return [];
  }
};
