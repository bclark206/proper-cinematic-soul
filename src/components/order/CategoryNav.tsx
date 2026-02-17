import { useRef, useEffect } from "react";
import type { Category } from "@/data/menu";
import { cn } from "@/lib/utils";

interface CategoryNavProps {
  categories: Category[];
  activeCategory: string;
  onSelect: (slug: string) => void;
}

const CategoryNav = ({ categories, activeCategory, onSelect }: CategoryNavProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Scroll active category into view
  useEffect(() => {
    const activeButton = buttonRefs.current[activeCategory];
    if (activeButton && scrollRef.current) {
      const container = scrollRef.current;
      const buttonLeft = activeButton.offsetLeft;
      const buttonWidth = activeButton.offsetWidth;
      const containerWidth = container.offsetWidth;
      const scrollLeft = buttonLeft - containerWidth / 2 + buttonWidth / 2;
      container.scrollTo({ left: scrollLeft, behavior: "smooth" });
    }
  }, [activeCategory]);

  return (
    <div className="sticky top-20 z-40 bg-[#0a0a0a]/95 backdrop-blur-xl border-b border-gold/8">
      <div className="max-w-7xl mx-auto">
        <div
          ref={scrollRef}
          className="flex overflow-x-auto scrollbar-hide gap-1 px-4 py-3 sm:px-6 sm:justify-center"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {categories.map((cat) => (
            <button
              key={cat.slug}
              ref={(el) => { buttonRefs.current[cat.slug] = el; }}
              onClick={() => onSelect(cat.slug)}
              className={cn(
                "px-5 py-2 rounded-full text-sm font-medium transition-all duration-300 whitespace-nowrap shrink-0",
                activeCategory === cat.slug
                  ? "bg-gradient-to-r from-gold to-[hsl(43,40%,62%)] text-jet-black shadow-[0_2px_12px_rgba(197,168,106,0.3)] font-semibold"
                  : "text-cream/50 hover:text-gold hover:bg-gold/8 border border-transparent hover:border-gold/15"
              )}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CategoryNav;
