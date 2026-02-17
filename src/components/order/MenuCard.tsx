import { type MenuItem, formatPrice } from "@/data/menu";
import { Card, CardContent } from "@/components/ui/card";
import { Plus } from "lucide-react";

interface MenuCardProps {
  item: MenuItem;
  onClick: (item: MenuItem) => void;
}

const MenuCard = ({ item, onClick }: MenuCardProps) => {
  return (
    <Card
      className="group bg-[#1a1a1a] border-gold/10 hover:border-gold/30 hover:shadow-gold cursor-pointer transition-all duration-500 overflow-hidden"
      onClick={() => onClick(item)}
    >
      <CardContent className="p-0">
        {/* Image placeholder */}
        <div className="relative h-48 bg-gradient-to-br from-[#2a2018] to-[#1a1510] overflow-hidden">
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="font-display text-4xl text-gold/20">PC</span>
          </div>
          {/* Hover overlay */}
          <div className="absolute inset-0 bg-gold/0 group-hover:bg-gold/5 transition-colors duration-500 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-gold/0 group-hover:bg-gold flex items-center justify-center transition-all duration-300 opacity-0 group-hover:opacity-100 scale-75 group-hover:scale-100">
              <Plus className="w-6 h-6 text-jet-black" />
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-5">
          <div className="flex items-start justify-between gap-3 mb-2">
            <h3 className="font-display text-lg font-semibold text-pure-white group-hover:text-gold transition-colors duration-300 leading-tight">
              {item.name}
            </h3>
            <span className="text-gold font-semibold whitespace-nowrap text-base">
              {formatPrice(item.price)}
            </span>
          </div>
          {item.description && (
            <p className="text-cream/50 text-sm leading-relaxed line-clamp-2">
              {item.description}
            </p>
          )}
          {item.modifierListIds.length > 0 && (
            <div className="mt-3 flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-gold/60 bg-gold/10 px-2 py-0.5 rounded-full">
                Customizable
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default MenuCard;
