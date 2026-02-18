import { Skeleton } from "@/components/ui/skeleton";

const MenuCardSkeleton = () => {
  return (
    <div
      data-testid="menu-card-skeleton"
      className="bg-[#131313] border border-[#1f1f1f] rounded-xl overflow-hidden"
    >
      {/* Image area — matches MenuCard aspect ratios */}
      <Skeleton className="aspect-square sm:aspect-[3/2] w-full rounded-none bg-[#1a1a1a]" />

      {/* Content area — matches MenuCard padding */}
      <div className="px-2.5 pt-2.5 pb-3 sm:px-5 sm:pt-5 sm:pb-5">
        <Skeleton className="h-4 sm:h-5 w-3/4 bg-[#1a1a1a]" />
        <Skeleton className="hidden sm:block mt-2 h-3 w-full bg-[#1a1a1a]" />
        <Skeleton className="hidden sm:block mt-1.5 h-3 w-2/3 bg-[#1a1a1a]" />
      </div>
    </div>
  );
};

export default MenuCardSkeleton;
