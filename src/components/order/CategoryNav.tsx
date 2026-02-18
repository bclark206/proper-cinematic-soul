import { useRef, useEffect, useState, useCallback } from "react";
import type { Category } from "@/data/menu";
import { cn } from "@/lib/utils";

interface CategoryNavProps {
  categories: Category[];
  activeCategory: string;
  onSelect: (slug: string) => void;
}

interface IndicatorStyle {
  left: number;
  width: number;
}

const CategoryNav = ({ categories, activeCategory, onSelect }: CategoryNavProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState<IndicatorStyle | null>(null);

  const updateIndicator = useCallback(() => {
    const activeButton = buttonRefs.current[activeCategory];
    const container = scrollRef.current;
    if (!activeButton || !container) return;

    const containerRect = container.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();

    setIndicator({
      left: buttonRect.left - containerRect.left + container.scrollLeft,
      width: buttonRect.width,
    });
  }, [activeCategory]);

  // Update indicator position when active category changes
  useEffect(() => {
    updateIndicator();
  }, [updateIndicator]);

  // Recalculate on resize
  useEffect(() => {
    const handleResize = () => updateIndicator();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [updateIndicator]);

  // Scroll active category button into view
  useEffect(() => {
    const activeButton = buttonRefs.current[activeCategory];
    if (activeButton && scrollRef.current) {
      const container = scrollRef.current;
      const buttonLeft = activeButton.offsetLeft;
      const buttonWidth = activeButton.offsetWidth;
      const containerWidth = container.offsetWidth;
      const scrollLeft = buttonLeft - containerWidth / 2 + buttonWidth / 2;
      container.scrollTo?.({ left: scrollLeft, behavior: "smooth" });
    }
  }, [activeCategory]);

  // Update indicator when container scrolls (keeps it aligned)
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleScroll = () => updateIndicator();
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [updateIndicator]);

  return (
    <div
      className="sticky top-20 z-40 bg-[#0a0a0a]/95 backdrop-blur-xl border-b border-gold/8"
      role="navigation"
      aria-label="Menu categories"
    >
      <div className="max-w-7xl mx-auto">
        <div
          ref={scrollRef}
          className="relative flex overflow-x-auto scrollbar-hide gap-0.5 sm:gap-1 px-3 py-2 sm:px-6 sm:py-3 sm:justify-center scroll-touch"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {/* Sliding indicator */}
          {indicator && (
            <div
              data-testid="active-indicator"
              className="absolute bottom-0 h-0.5 bg-gradient-to-r from-gold to-[hsl(43,40%,62%)] rounded-full transition-all duration-300 ease-out"
              style={{
                left: indicator.left,
                width: indicator.width,
              }}
            />
          )}

          {categories.map((cat) => (
            <button
              key={cat.slug}
              ref={(el) => { buttonRefs.current[cat.slug] = el; }}
              onClick={() => onSelect(cat.slug)}
              aria-current={activeCategory === cat.slug ? "true" : undefined}
              className={cn(
                "px-3.5 py-1.5 sm:px-5 sm:py-2 rounded-full text-xs sm:text-sm font-medium transition-all duration-300 whitespace-nowrap shrink-0",
                activeCategory === cat.slug
                  ? "text-gold font-semibold"
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
