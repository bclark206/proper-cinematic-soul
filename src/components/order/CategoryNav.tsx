import { CATEGORIES, type CategorySlug } from "@/data/menu";
import { cn } from "@/lib/utils";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface CategoryNavProps {
  activeCategory: CategorySlug;
  onSelect: (slug: CategorySlug) => void;
}

const CategoryNav = ({ activeCategory, onSelect }: CategoryNavProps) => {
  return (
    <div className="sticky top-20 z-40 bg-jet-black/95 backdrop-blur-md border-b border-gold/10">
      <div className="max-w-7xl mx-auto">
        <ScrollArea className="w-full whitespace-nowrap">
          <div className="flex space-x-1 px-4 py-3 sm:px-6 sm:justify-center">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.slug}
                onClick={() => onSelect(cat.slug)}
                className={cn(
                  "px-4 py-2 rounded-full text-sm font-medium transition-all duration-300 whitespace-nowrap",
                  activeCategory === cat.slug
                    ? "bg-gradient-to-r from-gold to-[hsl(43,35%,68%)] text-jet-black shadow-gold"
                    : "text-cream/70 hover:text-gold hover:bg-gold/10"
                )}
              >
                {cat.name}
              </button>
            ))}
          </div>
          <ScrollBar orientation="horizontal" className="invisible" />
        </ScrollArea>
      </div>
    </div>
  );
};

export default CategoryNav;
